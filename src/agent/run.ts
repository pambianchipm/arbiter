import Anthropic from "@anthropic-ai/sdk";
import type { Effort } from "../config.js";
import type { TurnInput, TurnResult } from "../types.js";
import { SYSTEM_PROMPT, buildTurnContent } from "./prompts.js";
import { TOOL_DEFS, executeTool, type ToolContext } from "./tools.js";
import { log, errMsg } from "../log.js";

type StreamParams = Parameters<Anthropic["beta"]["messages"]["stream"]>[0];

export interface AgentOptions {
  model: string;
  effort: Effort;
  fastMode: boolean;
  maxIterations: number;
  /** server-side refusal fallbacks (Opus 5 family). Off if the org's API doesn't accept the beta. */
  fallbacks: boolean;
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

  /** set once a 400 is traced to optional betas (fast mode / fallbacks); they're dropped for the rest of the process */
  private degraded = false;

  private hasExtras(): boolean {
    return this.opts.fastMode || this.opts.fallbacks;
  }

  private buildParams(messages: Anthropic.Beta.BetaMessageParam[], withExtras: boolean): StreamParams {
    const betas: string[] = [];
    if (withExtras && this.opts.fastMode) betas.push("fast-mode-2026-02-01");
    if (withExtras && this.opts.fallbacks) betas.push("server-side-fallback-2026-07-01");
    return {
      model: this.opts.model,
      max_tokens: 32_000,
      system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
      tools: TOOL_DEFS,
      messages,
      output_config: { effort: this.opts.effort },
      ...(betas.length ? { betas } : {}),
      ...(withExtras && this.opts.fastMode ? { speed: "fast" as const } : {}),
      ...(withExtras && this.opts.fallbacks ? { fallbacks: "default" as const } : {}),
    };
  }

  private async call(messages: Anthropic.Beta.BetaMessageParam[]): Promise<Anthropic.Beta.BetaMessage> {
    try {
      return await this.client.beta.messages.stream(this.buildParams(messages, !this.degraded)).finalMessage();
    } catch (e) {
      // A 400 while optional betas are on is almost always the org's API not accepting one of them.
      // Retry once without them and stay degraded for the process lifetime.
      if (e instanceof Anthropic.BadRequestError && !this.degraded && this.hasExtras()) {
        log.warn(`Claude rejected the request (${e.message}). Retrying without optional betas (fast mode / refusal fallbacks) for the rest of this run.`);
        this.degraded = true;
        return await this.client.beta.messages.stream(this.buildParams(messages, false)).finalMessage();
      }
      throw e;
    }
  }

  async runTurn(input: TurnInput & { currentHtml?: string }, ctx: ToolContext): Promise<TurnResult> {
    const result = ctx.result;
    const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content: buildTurnContent(input) }];

    let finalText = "";
    for (let i = 0; i < this.opts.maxIterations; i++) {
      result.iterations = i + 1;
      let msg: Anthropic.Beta.BetaMessage;
      try {
        msg = await this.call(messages);
      } catch (e) {
        result.error = describeApiError(e);
        log.error("claude call failed", result.error);
        break;
      }

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
  if (e instanceof Anthropic.AuthenticationError) return "Anthropic auth failed (check ANTHROPIC_API_KEY in .env).";
  if (e instanceof Anthropic.NotFoundError) return `Model not found (${e.message}). Check ARBITER_MODEL in .env.`;
  if (e instanceof Anthropic.PermissionDeniedError) return `Permission denied by the Claude API: ${e.message}`;
  if (e instanceof Anthropic.RateLimitError) return "Rate limited by the Claude API; try again in a moment.";
  if (e instanceof Anthropic.BadRequestError) return `Bad request to Claude: ${e.message}`;
  if (e instanceof Anthropic.APIConnectionError) return "Could not reach the Claude API.";
  if (e instanceof Anthropic.APIError) return `Claude API error ${e.status}: ${e.message}`;
  return errMsg(e);
}
