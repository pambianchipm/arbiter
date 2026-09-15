import Anthropic from "@anthropic-ai/sdk";
import { log, errMsg } from "../log.js";

/** Root-mean-square level of 48k stereo s16le PCM; speech at normal Discord levels is well above ~400. */
export function rmsLevel(pcm: Buffer): number {
  const n = Math.floor(pcm.length / 2);
  if (!n) return 0;
  let acc = 0;
  for (let i = 0; i < n; i++) {
    const v = pcm.readInt16LE(i * 2);
    acc += v * v;
  }
  return Math.sqrt(acc / n);
}

const NAME = /\b(arbiter|arbitor|arbitrer|arbitur|our biter|arbiters)\b[,:]?\s*/i;

/** Address mode: only lines that name the agent count. Returns the line with the name stripped, or undefined. */
export function addressedToArbiter(text: string): string | undefined {
  if (!NAME.test(text)) return undefined;
  const stripped = text.replace(NAME, "").replace(/^(hey|hi|ok|okay|yo)[,\s]+/i, "").trim();
  return stripped || text;
}

export interface GateInput {
  brief: string;
  speaker: string;
  text: string;
  recent: string[]; // last few lines as "Name: text"
}

/**
 * Listen mode: a fast, cheap model decides whether a transcript line is something the design agent
 * should act on (feedback, a request, a decision, an answer, a constraint) or side talk / filler.
 * Fails open: if the check errors, the line counts as actionable.
 */
export class RelevanceGate {
  constructor(
    private readonly client: Anthropic,
    private readonly model = "claude-haiku-4-5",
  ) {}

  async check(input: GateInput): Promise<{ actionable: boolean; why: string }> {
    const prompt = [
      `A design agent is listening to a team's voice call about this page: "${input.brief}".`,
      `Decide whether the LATEST line is something the agent should act on: feedback about the page, a change request, a decision, an answer to the agent's question, a constraint, or a question for the agent.`,
      `Not actionable: greetings, filler, laughter, side conversation, logistics, talking about something other than the page, thinking out loud with no ask, or fragments too short to mean anything.`,
      input.recent.length ? `Recent lines:\n${input.recent.map((l) => `- ${l}`).join("\n")}` : "",
      `LATEST: ${input.speaker}: ${input.text}`,
      `Reply with exactly one line of JSON: {"actionable": true|false, "why": "<8 words>"}`,
    ]
      .filter(Boolean)
      .join("\n\n");
    try {
      const res = await this.client.messages.create({ model: this.model, max_tokens: 80, messages: [{ role: "user", content: prompt }] });
      const text = res.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("");
      const m = /"actionable"\s*:\s*(true|false)/i.exec(text);
      const why = /"why"\s*:\s*"([^"]*)"/.exec(text)?.[1] ?? "";
      if (!m) return { actionable: true, why: "unparseable, kept" };
      return { actionable: m[1].toLowerCase() === "true", why };
    } catch (e) {
      log.warn("relevance gate failed (keeping line):", errMsg(e));
      return { actionable: true, why: "gate error, kept" };
    }
  }
}
