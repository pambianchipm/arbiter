import type { Project } from "./types.js";
import { currentVersion } from "./types.js";

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
