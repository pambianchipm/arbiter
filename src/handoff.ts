import type { Project } from "./types.js";
import { currentVersion } from "./types.js";
import type { Store } from "./store.js";

/**
 * Deterministic handoff spec: everything an engineer needs to build the final version,
 * with provenance for every decision. No model call — this must never fail.
 */
export function generateHandoff(p: Project): string {
  const cur = currentVersion(p);
  const L: string[] = [];
  const when = (iso: string) => new Date(iso).toISOString().replace("T", " ").slice(0, 16) + "Z";
  const nameOf = (id: string) => p.participants[id]?.name ?? id;

  L.push(`# Handoff: ${p.brief}`);
  L.push(``);
  L.push(`Generated ${when(new Date().toISOString())} from Discord thread \`${p.threadId}\`. Status: **${p.status}**.`);
  L.push(``);
  L.push(`## Final version`);
  if (cur) {
    L.push(`**${cur.id}** — ${cur.summary}`);
    L.push(`Preview: ${cur.previewUrl}`);
    if (cur.approvals.length) L.push(`Approved by: ${cur.approvals.map(nameOf).join(", ")}`);
    L.push(`Source: \`${cur.id}.html\` (attached). Single-file HTML using Tailwind CDN; translate utility classes 1:1 into your component system.`);
  } else {
    L.push(`No version published yet.`);
  }

  L.push(``);
  L.push(`## Decisions (with provenance)`);
  if (!p.decisions.length) L.push(`_none logged_`);
  p.decisions.forEach((d, i) => {
    L.push(`${i + 1}. **${d.summary}**${d.versionId ? ` _(landed in ${d.versionId})_` : ""}`);
    L.push(`   - asked by: ${d.requestedBy.join(", ") || "—"}`);
    L.push(`   - why: ${d.rationale}`);
    L.push(`   - when: ${when(d.at)}`);
  });

  L.push(``);
  L.push(`## Constraints (must hold)`);
  if (!p.constraints.length) L.push(`_none_`);
  for (const c of p.constraints) L.push(`- ${c.text} — from ${c.source}, ${when(c.at)}`);

  const forks = [...p.forkHistory, ...(p.fork ? [p.fork] : [])];
  if (forks.length) {
    L.push(``);
    L.push(`## Disagreements and how they were settled`);
    for (const f of forks) {
      const a = Object.values(f.votes).filter((v) => v === "a").length;
      const b = Object.values(f.votes).filter((v) => v === "b").length;
      const res = f.resolved ? `${f.resolved.winner === "tie" ? "tie" : f.resolved.winner.toUpperCase() + " won"} (A ${a}, B ${b}), resolved by ${f.resolved.by} at ${when(f.resolved.at)}` : `still open (A ${a}, B ${b})`;
      L.push(`- **${f.question}**`);
      L.push(`  - A "${f.a.label}"${f.a.champion ? ` for ${f.a.champion}` : ""}: ${f.a.rationale}`);
      L.push(`  - B "${f.b.label}"${f.b.champion ? ` for ${f.b.champion}` : ""}: ${f.b.rationale}`);
      L.push(`  - Result: ${res}`);
      const voters = Object.entries(f.votes).map(([uid, v]) => `${nameOf(uid)} → ${v.toUpperCase()}`);
      if (voters.length) L.push(`  - Votes: ${voters.join(", ")}`);
    }
  }

  if (p.style) {
    L.push(``);
    L.push(`## Style${p.style.source ? ` (reference: ${p.style.source})` : ""}`);
    L.push(p.style.summary);
    if (p.style.palette?.length) L.push(`- Palette: ${p.style.palette.join(", ")}`);
    if (p.style.typography) L.push(`- Typography: ${p.style.typography}`);
    if (p.style.spacing) L.push(`- Spacing: ${p.style.spacing}`);
    if (p.style.vibe) L.push(`- Vibe: ${p.style.vibe}`);
  }

  const open = p.questions.filter((q) => !q.answered);
  L.push(``);
  L.push(`## Open questions`);
  if (!open.length) L.push(`_none_`);
  for (const q of open) L.push(`- to ${q.to}: ${q.text}`);

  L.push(``);
  L.push(`## Version history`);
  for (const v of p.versions) {
    L.push(`- **${v.id}**${v.label ? ` (${v.label})` : ""} — ${v.summary}${v.addresses.length ? ` _(for ${v.addresses.join(", ")})_` : ""}`);
    for (const c of v.changes) L.push(`  - ${c}`);
  }

  L.push(``);
  L.push(`## People`);
  for (const x of Object.values(p.participants)) L.push(`- ${x.name} — ${x.role ?? "role not set"}`);

  L.push(``);
  L.push(`---`);
  L.push(`_Assembled by Arbiter from the thread. Every decision above links back to who asked for it and why._`);
  return L.join("\n");
}


/**
 * A prompt-shaped brief for a coding agent (Claude Code, Codex, Grok, …): paste it in
 * alongside the final HTML and the agent has the goal, the constraints, every decision
 * with provenance, and an acceptance checklist. Deterministic, no model call.
 */
export function generateBuildBrief(p: Project, stack?: string): string {
  const cur = currentVersion(p);
  const L: string[] = [];
  const byRole = (role: string) => Object.values(p.participants).filter((x) => x.role === role).map((x) => x.name);
  const target = stack?.trim() || "the project's existing stack and component system";

  L.push(`# Build brief: ${p.brief}`);
  L.push(``);
  L.push(`You are a coding agent implementing a UI that a team already designed and approved in Discord with Arbiter. Implement it in **${target}**. The source of truth is \`${cur?.id ?? "the latest"}.html\` (single-file Tailwind prototype, attached) plus this brief. Do not redesign; port faithfully.`);
  L.push(``);
  L.push(`## Goal`);
  L.push(p.brief);
  if (cur) {
    L.push(``);
    L.push(`Final approved version: **${cur.id}** — ${cur.summary}${cur.approvals.length ? ` (approved by ${cur.approvals.length} of ${Object.keys(p.participants).length})` : ""}.`);
  }

  L.push(``);
  L.push(`## Non-negotiables`);
  if (!p.constraints.length) L.push(`- None recorded. Keep the prototype's structure and copy.`);
  for (const c of p.constraints) L.push(`- ${c.text} _(stated by ${c.source})_`);
  L.push(`- Keep all copy exactly as in the prototype; it was reviewed.`);
  L.push(`- Where the prototype and a non-negotiable conflict, the non-negotiable wins; leave a \`TODO(arbiter)\` comment naming it.`);

  L.push(``);
  L.push(`## Decisions to preserve (do not relitigate)`);
  if (!p.decisions.length) L.push(`- none logged`);
  for (const d of p.decisions) L.push(`- ${d.summary} — asked by ${d.requestedBy.join(", ") || "the team"}; ${d.rationale}${d.versionId ? ` _(landed in ${d.versionId})_` : ""}`);

  const forks = [...p.forkHistory, ...(p.fork ? [p.fork] : [])].filter((f) => f.resolved);
  if (forks.length) {
    L.push(``);
    L.push(`## Settled disagreements`);
    for (const f of forks) {
      const win = f.resolved!.winner === "tie" ? "tie, settled by the role rule" : `${f.resolved!.winner.toUpperCase()} "${f.resolved!.winner === "a" ? f.a.label : f.b.label}"`;
      L.push(`- ${f.question} → ${win}. Do not reopen.`);
    }
  }

  if (p.style) {
    L.push(``);
    L.push(`## Style tokens`);
    L.push(p.style.summary);
    if (p.style.palette?.length) L.push(`- Palette: ${p.style.palette.join(", ")}`);
    if (p.style.typography) L.push(`- Typography: ${p.style.typography}`);
    if (p.style.spacing) L.push(`- Spacing: ${p.style.spacing}`);
  }

  L.push(``);
  L.push(`## Acceptance checklist`);
  L.push(`- [ ] Visual parity with \`${cur?.id ?? "latest"}.png\` at 1280×800 (attached) and a sensible mobile layout`);
  L.push(`- [ ] Every non-negotiable above holds`);
  for (const d of p.decisions) L.push(`- [ ] ${d.summary}`);
  L.push(`- [ ] No external image URLs; placeholders stay CSS/SVG until real assets exist`);
  L.push(`- [ ] Tailwind utility classes ported 1:1 to the target system's equivalents`);

  L.push(``);
  L.push(`## Who to ask`);
  const pm = byRole("pm"), des = byRole("designer"), eng = byRole("eng");
  L.push(`- Content and priority: ${pm.join(", ") || "the PM"}`);
  L.push(`- Visual calls: ${des.join(", ") || "the designer"}`);
  L.push(`- Feasibility and stack: ${eng.join(", ") || "engineering"}`);
  const open = p.questions.filter((q) => !q.answered);
  if (open.length) {
    L.push(``);
    L.push(`Open questions the team never answered (make a reasonable call and flag it):`);
    for (const q of open) L.push(`- (${q.to}) ${q.text}`);
  }

  L.push(``);
  L.push(`## Files`);
  if (cur) L.push(`- \`${cur.id}.html\` — the prototype to port`);
  if (cur) L.push(`- \`${cur.id}.png\` — what it should look like`);
  L.push(`- \`handoff-${p.id}.md\` — full decision log with timestamps and votes`);
  return L.join("\n");
}


/** Everything /handoff, the 📦 button and the agent's post_handoff tool post. */
export async function buildHandoffFiles(store: Store, p: Project, stack?: string): Promise<{ files: { name: string; data: Buffer }[]; text: string }> {
  const files: { name: string; data: Buffer }[] = [
    { name: `handoff-${p.id}.md`, data: Buffer.from(generateHandoff(p), "utf8") },
    { name: "BUILD.md", data: Buffer.from(generateBuildBrief(p, stack), "utf8") },
  ];
  const cur = currentVersion(p);
  if (cur) {
    const html = await store.readHtml(p.id, cur.id);
    if (html) files.push({ name: `${cur.id}.html`, data: Buffer.from(html, "utf8") });
    const png = await store.readPng(p.id, cur.id);
    if (png) files.push({ name: `${cur.id}.png`, data: png });
  }
  const n = (k: number, w: string) => `${k} ${w}${k === 1 ? "" : "s"}`;
  const text =
    `📦 Handoff for **${p.brief}** — ${n(p.decisions.length, "decision")}, ${n(p.constraints.length, "constraint")}, ${n(p.versions.length, "version")}.\n` +
    `\`BUILD.md\` is written for a coding agent${stack ? ` targeting **${stack}**` : ""}: drop it and the HTML into Claude Code, Codex or Grok and say "build this". \`${cur?.id ?? "vN"}.html\` runs anywhere as-is.`;
  return { files, text };
}
