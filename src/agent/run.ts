import Anthropic from "@anthropic-ai/sdk";
import type { Effort } from "../config.js";
import type { TurnInput, TurnResult, TurnUsage } from "../types.js";
import { SYSTEM_PROMPT, buildTurnContent } from "./prompts.js";
import { TOOL_DEFS, executeTool, type ToolContext } from "./tools.js";
import { log, errMsg } from "../log.js";

type StreamParams = Parameters<Anthropic["beta"]["messages"]["stream"]>[0];

export interface AgentOptions {
  /** the model for kickoff, forks, fork winners, and any batch with more than one author */
  model: string;
  /** a cheaper model for single-author edit turns; empty or undefined = same as model */
  editModel?: string;
  effort: Effort;
  fastMode: boolean;
  maxIterations: number;
  /** server-side refusal fallbacks (Opus 5 family). Off if the org's API doesn't accept the beta. */
  fallbacks: boolean;
}

export interface RequestExtras {
  betas: string[];
  speed?: "fast";
  fallbacks?: "default";
}

/**
 * The optional betas a request may carry. Fast mode and refusal fallbacks are Opus-family features;
 * sending them to Sonnet returns a 400, so they are keyed on the model, not on the process.
 */
export function requestExtras(model: string, opts: Pick<AgentOptions, "fastMode" | "fallbacks">, enabled: boolean): RequestExtras {
  const out: RequestExtras = { betas: [] };
  if (!enabled || !/opus|fable/i.test(model)) return out;
  if (opts.fastMode) {
    out.betas.push("fast-mode-2026-02-01");
    out.speed = "fast";
  }
  if (opts.fallbacks) {
    out.betas.push("server-side-fallback-2026-07-01");
    out.fallbacks = "default";
  }
  return out;
}

/** Edit turns (one person's feedback on an existing page) run on the cheaper model when one is configured. */
export function modelFor(opts: Pick<AgentOptions, "model" | "editModel">, tier: TurnInput["tier"]): string {
  return tier === "edit" && opts.editModel ? opts.editModel : opts.model;
}

/**
 * One Claude tool loop per turn. Each turn is rebuilt from project state (no growing
 * chat history), so context stays bounded no matter how long the thread runs. Tools
 * post to the surface as they execute, so the team sees progress mid-turn.
 */
export class Agent {
  constructor(
    private readonly client: Anthropic,
    private readonly opts: AgentOptions,
  ) {}

  /** models whose requests were rejected with the optional betas on; they run without them for the rest of the process */
  private degraded = new Set<string>();

  private buildParams(model: string, messages: Anthropic.Beta.BetaMessageParam[]): StreamParams {
    const extras = requestExtras(model, this.opts, !this.degraded.has(model));
    return {
      model,
      max_tokens: 32_000,
      // Two cache breakpoints. The explicit one pins the byte-stable prefix (tools + system prompt) across
      // turns. The top-level one moves with the last message, so iterations 2..n of a turn read the whole
      // turn prompt (transcript, current HTML, earlier tool results) from cache at a tenth of the price.
      system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
      cache_control: { type: "ephemeral" },
      tools: TOOL_DEFS,
      messages,
      output_config: { effort: this.opts.effort },
      ...(extras.betas.length ? { betas: extras.betas } : {}),
      ...(extras.speed ? { speed: extras.speed } : {}),
      ...(extras.fallbacks ? { fallbacks: extras.fallbacks } : {}),
    };
  }

  /**
   * The client is a parameter, never instance state: turns for different servers run concurrently
   * and each must stay on its own key (bring-your-own-key) for every iteration.
   */
  private async call(client: Anthropic, model: string, messages: Anthropic.Beta.BetaMessageParam[]): Promise<Anthropic.Beta.BetaMessage> {
    try {
      return await client.beta.messages.stream(this.buildParams(model, messages)).finalMessage();
    } catch (e) {
      // A 400 while optional betas are on is almost always the org's API not accepting one of them.
      // Retry once without them and keep that model degraded for the process lifetime.
      if (e instanceof Anthropic.BadRequestError && !this.degraded.has(model) && requestExtras(model, this.opts, true).betas.length) {
        log.warn(`Claude rejected the request for ${model} (${e.message}). Retrying without optional betas (fast mode / refusal fallbacks) for the rest of this run.`);
        this.degraded.add(model);
        return await client.beta.messages.stream(this.buildParams(model, messages)).finalMessage();
      }
      throw e;
    }
  }

  async runTurn(input: TurnInput, ctx: ToolContext, client: Anthropic = this.client): Promise<TurnResult> {
    const result = ctx.result;
    const model = modelFor(this.opts, input.tier);
    const usage: TurnUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    result.model = model;
    result.usage = usage;
    const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content: buildTurnContent(input) }];

    let finalText = "";
    for (let i = 0; i < this.opts.maxIterations; i++) {
      result.iterations = i + 1;
      let msg: Anthropic.Beta.BetaMessage;
      try {
        msg = await this.call(client, model, messages);
      } catch (e) {
        result.error = describeApiError(e);
        log.error("claude call failed", result.error);
        break;
      }
      usage.input += msg.usage.input_tokens;
      usage.output += msg.usage.output_tokens;
      usage.cacheRead += msg.usage.cache_read_input_tokens ?? 0;
      usage.cacheWrite += msg.usage.cache_creation_input_tokens ?? 0;

      if (msg.stop_reason === "refusal") {
        result.error = "Claude declined this request.";
        break;
      }

      messages.push({ role: "assistant", content: msg.content });
      const text = msg.content
        .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();
      const toolUses = msg.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");

      if (msg.stop_reason !== "tool_use" || toolUses.length === 0) {
        finalText = text;
        if (msg.stop_reason === "max_tokens") result.error = "Response was cut off (max_tokens).";
        break;
      }

      // Execute sequentially so posts land in the order the model intended; return all
      // results in one user message.
      const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
      for (const tu of toolUses) {
        result.toolCalls++;
        log.info(`tool → ${tu.name}`);
        const out = await executeTool(tu.name, tu.input, ctx);
        results.push({ type: "tool_result", tool_use_id: tu.id, content: out.content, is_error: out.isError ?? false });
      }
      messages.push({ role: "user", content: results });

      if (i === this.opts.maxIterations - 1) {
        result.error = "Stopped after the maximum number of steps for one turn.";
      }
    }

    result.text = finalText;
    return result;
  }
}

function describeApiError(e: unknown): string {
  if (e instanceof Anthropic.AuthenticationError) return "Anthropic rejected the API key (check ANTHROPIC_API_KEY in .env).";
  if (errMsg(e).includes("Could not resolve authentication method")) {
    return "No Anthropic API key found. In the arbiter folder run `cp .env.example .env`, put your key after ANTHROPIC_API_KEY= in .env, then restart.";
  }
  if (e instanceof Anthropic.NotFoundError) return `Model not found (${e.message}). Check ARBITER_MODEL and ARBITER_EDIT_MODEL in .env.`;
  if (e instanceof Anthropic.PermissionDeniedError) return `Permission denied by the Claude API: ${e.message}`;
  if (e instanceof Anthropic.RateLimitError) return "Rate limited by the Claude API; try again in a moment.";
  if (e instanceof Anthropic.BadRequestError) return `Bad request to Claude: ${e.message}`;
  if (e instanceof Anthropic.APIConnectionError) return "Could not reach the Claude API.";
  if (e instanceof Anthropic.APIError) return `Claude API error ${e.status}: ${e.message}`;
  return errMsg(e);
}
