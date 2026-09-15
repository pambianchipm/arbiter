import { zipSync } from "fflate";
import type { Brand, Project } from "./types.js";
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


function slug(x: string): string {
  return x.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "page";
}

export function generateBrandDoc(b: Brand): string {
  const L: string[] = [`# Brand: ${b.name}`, ``, `Design system as approved by the team across ${b.pages.length} page${b.pages.length === 1 ? "" : "s"}. Reuse \`header.html\`, \`footer.html\` and \`head.html\` verbatim on new pages.`, ``];
  if (b.style) {
    L.push(`## Tokens`, b.style.summary);
    if (b.style.palette?.length) L.push(`- Palette: ${b.style.palette.join(", ")}`);
    if (b.style.typography) L.push(`- Typography: ${b.style.typography}`);
    if (b.style.spacing) L.push(`- Spacing: ${b.style.spacing}`);
    if (b.style.vibe) L.push(`- Vibe: ${b.style.vibe}`);
    L.push(``);
  }
  if (b.voice) L.push(`## Voice`, b.voice, ``);
  L.push(`## Rules that hold on every page`);
  if (!b.decisions.length) L.push(`_none yet_`);
  for (const d of b.decisions) L.push(`- ${d.summary} — ${d.requestedBy.join(", ") || "team"}; ${d.rationale}`);
  L.push(``, `## Constraints`);
  if (!b.constraints.length) L.push(`_none_`);
  for (const c of b.constraints) L.push(`- ${c.text} _(${c.source})_`);
  L.push(``, `## Site map`);
  for (const pg of b.pages) L.push(`- ${pg.brief} — \`site/${slug(pg.brief)}/index.html\` (${pg.versionId}, shipped ${pg.shippedAt.slice(0, 10)})`);
  const people = Object.values(b.people);
  if (people.length) L.push(``, `## People`, ...people.map((x) => `- ${x.name}${x.role ? ` — ${x.role}` : ""}`));
  return L.join("\n");
}

/**
 * Everything /handoff, the 📦 button and the agent's post_handoff tool post: one zip laid out for a
 * coding agent, plus the screenshot so the thread still shows the image.
 */
export async function buildHandoffFiles(store: Store, p: Project, stack?: string, brand?: Brand): Promise<{ files: { name: string; data: Buffer }[]; text: string }> {
  const cur = currentVersion(p);
  const entries: Record<string, Uint8Array> = {};
  const put = (name: string, data: string | Buffer) => {
    entries[name] = typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  };

  put("BUILD.md", generateBuildBrief(p, stack));
  put("handoff.md", generateHandoff(p));
  let png: Buffer | undefined;
  if (cur) {
    const html = await store.readHtml(p.id, cur.id);
    if (html) put("index.html", html);
    png = await store.readPng(p.id, cur.id);
    if (png) put("screenshot.png", png);
  }
  const readme = [
    `# ${p.brief}`,
    ``,
    `Handoff package from Arbiter.`,
    ``,
    `- \`BUILD.md\` — start here: a brief for a coding agent (goal, non-negotiables, decisions to preserve, acceptance checklist).`,
    `- \`index.html\` — the approved prototype (single file, Tailwind CDN). \`screenshot.png\` is what it should look like at 1280×800.`,
    `- \`handoff.md\` — the full decision log with who asked, why, when, and how disagreements were settled.`,
    brand ? `- \`brand/\` — the team's design system: tokens, voice, rules, and the shared header/footer/head to reuse verbatim.` : ``,
    brand && brand.pages.some((pg) => pg.threadId !== p.id) ? `- \`site/\` — every other page already approved on this brand.` : ``,
  ]
    .filter(Boolean)
    .join("\n");
  put("README.md", readme);

  if (brand) {
    put("brand/brand.md", generateBrandDoc(brand));
    if (brand.chrome?.header) put("brand/header.html", brand.chrome.header);
    if (brand.chrome?.footer) put("brand/footer.html", brand.chrome.footer);
    if (brand.chrome?.head) put("brand/head.html", brand.chrome.head);
    for (const pg of brand.pages) {
      if (pg.threadId === p.id) continue;
      const html = await store.readHtml(pg.threadId, pg.versionId);
      if (html) put(`site/${slug(pg.brief)}/index.html`, html);
      const shot = await store.readPng(pg.threadId, pg.versionId);
      if (shot) put(`site/${slug(pg.brief)}/screenshot.png`, shot);
    }
  }

  const zip = Buffer.from(zipSync(entries, { level: 6 }));
  const files: { name: string; data: Buffer }[] = [{ name: `arbiter-${slug(p.brief)}.zip`, data: zip }];
  if (png) files.push({ name: `${cur!.id}.png`, data: png });

  const n = (k: number, w: string) => `${k} ${w}${k === 1 ? "" : "s"}`;
  const extraPages = brand ? brand.pages.filter((pg) => pg.threadId !== p.id).length : 0;
  const text =
    `📦 Handoff for **${p.brief}** — ${n(p.decisions.length, "decision")}, ${n(p.constraints.length, "constraint")}, ${n(p.versions.length, "version")}${brand ? `, brand **${brand.name}**${extraPages ? ` with ${n(extraPages, "other page")}` : ""}` : ""}.\n` +
    `Unzip and hand \`BUILD.md\`${stack ? ` (targeting **${stack}**)` : ""} to Claude Code, Codex or Grok: "build this". \`index.html\` runs anywhere as-is.`;
  return { files, text };
}
