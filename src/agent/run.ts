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

  async runTurn(input: TurnInput & { currentHtml?: string }, ctx: ToolContext): Promise<TurnResult> {
    const result = ctx.result;
    const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content: buildTurnContent(input) }];
    const betas: string[] = [];
    if (this.opts.fastMode) betas.push("fast-mode-2026-02-01");
    if (this.opts.fallbacks) betas.push("server-side-fallback-2026-07-01");

    let finalText = "";
    for (let i = 0; i < this.opts.maxIterations; i++) {
      result.iterations = i + 1;
      let msg: Anthropic.Beta.BetaMessage;
      try {
        const params: StreamParams = {
          model: this.opts.model,
          max_tokens: 32_000,
          system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
          tools: TOOL_DEFS,
          messages,
          output_config: { effort: this.opts.effort },
          ...(betas.length ? { betas } : {}),
          ...(this.opts.fastMode ? { speed: "fast" as const } : {}),
          ...(this.opts.fallbacks ? { fallbacks: "default" as const } : {}),
        };
        const stream = this.client.beta.messages.stream(params);
        msg = await stream.finalMessage();
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
  if (e instanceof Anthropic.AuthenticationError) return "Anthropic auth failed (check ANTHROPIC_API_KEY).";
  if (e instanceof Anthropic.RateLimitError) return "Rate limited by the Claude API; try again in a moment.";
  if (e instanceof Anthropic.BadRequestError) return `Bad request to Claude: ${e.message}`;
  if (e instanceof Anthropic.APIConnectionError) return "Could not reach the Claude API.";
  if (e instanceof Anthropic.APIError) return `Claude API error ${e.status}: ${e.message}`;
  return errMsg(e);
}
