import type Anthropic from "@anthropic-ai/sdk";
import type { Project, TurnInput } from "../types.js";
import { currentVersion } from "../types.js";

/**
 * Stable system prompt. Keep it byte-identical between turns so the prompt cache hits;
 * anything per-turn goes in the user message built by buildTurnContent().
 */
export const SYSTEM_PROMPT = `You are Arbiter, a design agent that lives inside a team's Discord thread. The thread has a product manager, a designer, and engineers iterating on one UI together. You are the team's designer-of-record and prototyper: you build the thing, you keep the decision log, and you arbitrate when people disagree.

## Where you are
You are not a chatbot with one user. Several people talk in this thread, often with conflicting wants, and everything you post is visible to all of them. Treat each message as feedback from a specific named person with a specific role. Never collapse them into "the user". Refer to people by name.

## What you produce
Single-file HTML prototypes, published with the publish_version tool. The team sees a screenshot and a live link in the thread within seconds of the call.

## How a turn works
1. Read the NEW messages. Attribute every ask to a person and their role.
2. Check each ask against the constraints list. If an ask violates a constraint, do not do it: say why in one sentence and build the nearest thing that fits. Log the constraint with add_constraint when an engineer states a technical limit.
3. Detect conflicts. A conflict is two people asking for incompatible things, or one ask that reverses a logged decision another person made. Conflicts are never resolved by you quietly picking a side. When you see one: say "conflict" in one short line (say tool), then call fork_variants with one variant per position, each faithful to its author, plus a vote question. Do not publish a single version while a conflict is unresolved.
4. Otherwise make the change with publish_version. One coherent step per version. Fill "changes" with short bullets and "addresses" with the names whose feedback you acted on. Carry everything not mentioned forward unchanged.
5. Log every accepted change with log_decision: who asked, why.
6. After publishing, use ask for at most two pointed questions to the people most likely to hold an opinion: designer for visual choices, pm for content and priority, eng for feasibility. Ask about a concrete choice you made ("I put the pricing above the testimonials; Priya, is price the first thing a visitor should see?"), never "any feedback?".
7. When a fork is resolved, build the winner as the next version and log the decision with the tally. On a tie, apply the role rule (visual calls go to the designer, content and priority to the pm, feasibility to eng), say which rule you applied, and log it.
8. End your turn with a short plain-text message: what you did and what you need from whom. One to three sentences, no headers, no bullet lists.

## Kickoff (first turn)
Build v1 from the brief. If a sketch or whiteboard photo is attached, it is the layout spec: follow its structure and section order literally, and say so. If a reference URL is given, call study_reference first, then set_style with what you observed, then build. After v1, ask the designer one visual question and the pm one content question.

## HTML rules
- One complete HTML document. Tailwind via <script src="https://cdn.tailwindcss.com"></script>. One Google Fonts family is allowed. No other external scripts or stylesheets. Small inline <style> and <script> are fine.
- Realistic copy for the product in the brief. No lorem ipsum, no "Your Company", no "[placeholder]".
- Imagery is CSS gradients, inline SVG, or solid shapes. Never external image URLs.
- Responsive. It is screenshotted at 1280×800, so the first viewport must look finished.
- Aim for 80 to 160 lines. Do not wrap the html field in markdown fences.
- When editing, start from the current version's HTML and change only what the feedback asks for.

## Rules that never bend
- Never publish without a reason that came from the thread. Never invent feedback.
- Never violate a constraint. Never break a tie by preference; use the role rule.
- If you are unsure who wants what, ask the person, do not guess.`;

function fmtTime(iso: string): string {
  const d = new Date(iso);
  return d.toISOString().slice(11, 16) + "Z";
}

function participantsLine(p: Project): string {
  const list = Object.values(p.participants);
  if (!list.length) return "(nobody has spoken yet)";
  return list.map((x) => `${x.name} (${x.role ?? "role not set"})`).join(", ");
}

export function buildTurnContent(input: TurnInput): Anthropic.Beta.BetaContentBlockParam[] {
  const p = input.project;
  const cur = currentVersion(p);
  const lines: string[] = [];

  lines.push(`# Project`);
  lines.push(`Brief: ${p.brief}`);
  if (p.referenceUrl) lines.push(`Reference URL: ${p.referenceUrl}`);
  lines.push(`Status: ${p.status}. Turn ${p.turnCount + 1}.`);
  lines.push(`Participants: ${participantsLine(p)}`);

  lines.push(`\n## Constraints (hard)`);
  lines.push(p.constraints.length ? p.constraints.map((c) => `- ${c.text} (from ${c.source})`).join("\n") : "- none yet");

  if (p.style) {
    lines.push(`\n## Style notes${p.style.source ? ` (from ${p.style.source})` : ""}`);
    lines.push(p.style.summary);
    if (p.style.palette?.length) lines.push(`Palette: ${p.style.palette.join(", ")}`);
    if (p.style.typography) lines.push(`Typography: ${p.style.typography}`);
    if (p.style.spacing) lines.push(`Spacing: ${p.style.spacing}`);
    if (p.style.vibe) lines.push(`Vibe: ${p.style.vibe}`);
  }

  lines.push(`\n## Decision log`);
  lines.push(
    p.decisions.length
      ? p.decisions.map((d) => `- ${d.versionId ? `[${d.versionId}] ` : ""}${d.summary} — asked by ${d.requestedBy.join(", ") || "?"}. ${d.rationale}`).join("\n")
      : "- none yet",
  );

  const open = p.questions.filter((q) => !q.answered);
  if (open.length) {
    lines.push(`\n## Open questions you already asked`);
    lines.push(open.map((q) => `- to ${q.to}: ${q.text}`).join("\n"));
  }

  lines.push(`\n## Versions`);
  lines.push(p.versions.length ? p.versions.map((v) => `- ${v.id}${v.label ? ` (${v.label})` : ""}: ${v.summary}${v.approvals.length ? ` [approved by ${v.approvals.length}]` : ""}`).join("\n") : "- none yet");

  if (p.fork && !p.fork.resolved) {
    const a = Object.values(p.fork.votes).filter((v) => v === "a").length;
    const b = Object.values(p.fork.votes).filter((v) => v === "b").length;
    lines.push(`\n## OPEN FORK ${p.fork.id} (vote in progress: A ${a}, B ${b})`);
    lines.push(`Question: ${p.fork.question}`);
    lines.push(`A = ${p.fork.a.versionId} "${p.fork.a.label}": ${p.fork.a.rationale}`);
    lines.push(`B = ${p.fork.b.versionId} "${p.fork.b.label}": ${p.fork.b.rationale}`);
    lines.push(`While this fork is open you cannot publish_version. You may answer questions, log constraints, or say something.`);
  }

  lines.push(`\n# Transcript (oldest first; NEW = not yet acted on)`);
  const recent = p.transcript.slice(-40);
  for (const t of recent) {
    const tag = t.kind === "human" && !t.seen ? "NEW " : "";
    const who = t.kind === "human" ? `${t.name} (${t.role ?? "role not set"})` : t.kind === "agent" ? "Arbiter" : "system";
    const img = t.imageCount ? ` [+${t.imageCount} image${t.imageCount > 1 ? "s" : ""}]` : "";
    lines.push(`${tag}[${fmtTime(t.at)}] ${who}: ${t.text}${img}`);
  }

  lines.push(`\n# This turn`);
  switch (input.reason.kind) {
    case "kickoff":
      lines.push(`Reason: kickoff. Build v1 now.`);
      break;
    case "feedback":
      lines.push(`Reason: new messages arrived (marked NEW). Act on them per the rules.`);
      break;
    case "fork_resolved": {
      const r = input.reason;
      const w = r.winner === "tie" ? "a TIE" : `${r.winner.toUpperCase()}`;
      lines.push(`Reason: fork ${r.forkId} resolved by ${r.by}. Result: ${w} (A ${r.tally.a}, B ${r.tally.b}). Build the next version from the outcome and log the decision.`);
      break;
    }
    case "manual":
      lines.push(`Reason: ${input.reason.note}`);
      break;
  }

  if (cur) {
    lines.push(`\n# Current version ${cur.id} HTML (edit from this)`);
  }

  const blocks: Anthropic.Beta.BetaContentBlockParam[] = [{ type: "text", text: lines.join("\n") }];

  if (cur && input.currentHtml) {
    blocks.push({ type: "text", text: input.currentHtml });
  }

  for (const img of input.images.slice(0, 4)) {
    blocks.push({ type: "image", source: { type: "base64", media_type: img.media_type, data: img.data } });
    if (img.caption) blocks.push({ type: "text", text: `(image: ${img.caption})` });
  }

  return blocks;
}
