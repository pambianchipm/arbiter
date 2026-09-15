import type { Brand, Project, Version } from "./types.js";
import { nowIso } from "./types.js";

export function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "default";
}

export function newBrand(guildId: string, name: string): Brand {
  return { id: slugify(name), guildId, name: name.trim() || "Default", createdAt: nowIso(), updatedAt: nowIso(), constraints: [], decisions: [], pages: [], people: {} };
}

const cap = (s: string | undefined, n: number) => (s && s.length > n ? undefined : s);

/** Lift the reusable shell out of an approved page: <head> extras (fonts, Tailwind config, styles), <header>, <footer>. */
export function extractChrome(html: string): { header?: string; footer?: string; head?: string } {
  const header = /<header\b[\s\S]*?<\/header>/i.exec(html)?.[0];
  const footer = /<footer\b[\s\S]*?<\/footer>/i.exec(html)?.[0];
  const headInner = /<head\b[^>]*>([\s\S]*?)<\/head>/i.exec(html)?.[1];
  const head = headInner
    ?.replace(/<title>[\s\S]*?<\/title>/gi, "")
    .replace(/<meta\b[^>]*>/gi, "")
    .replace(/\n\s*\n/g, "\n")
    .trim();
  return { header: cap(header, 8000), footer: cap(footer, 8000), head: cap(head, 6000) };
}

/** Fold a shipped page into the brand: chrome, tokens, constraints, people, site map. */
export function absorbShippedPage(brand: Brand, p: Project, v: Version, html: string): Brand {
  const chrome = extractChrome(html);
  if (chrome.header || chrome.footer || chrome.head) {
    brand.chrome = { ...chrome, fromThread: p.id, fromVersion: v.id, at: nowIso() };
  }
  if (p.style) brand.style = { ...brand.style, ...p.style };
  for (const c of p.constraints) {
    if (!brand.constraints.some((x) => x.text.toLowerCase() === c.text.toLowerCase())) brand.constraints.push(c);
  }
  for (const [id, who] of Object.entries(p.participants)) {
    brand.people[id] = { name: who.name, role: who.role ?? brand.people[id]?.role };
  }
  const page = { threadId: p.id, brief: p.brief, versionId: v.id, previewUrl: v.previewUrl.replace(/\/v\w+$/, "/current"), shippedAt: nowIso() };
  const i = brand.pages.findIndex((x) => x.threadId === p.id);
  if (i >= 0) brand.pages[i] = page;
  else brand.pages.push(page);
  return brand;
}

export function brandSummary(b: Brand): string {
  const L = [`🧠 **${b.name}** — ${b.pages.length} page${b.pages.length === 1 ? "" : "s"}, ${b.decisions.length} brand rule${b.decisions.length === 1 ? "" : "s"}, ${b.constraints.length} constraint${b.constraints.length === 1 ? "" : "s"}${b.chrome ? `, shared header/footer from ${b.chrome.fromVersion}` : ", no shared chrome yet"}.`];
  if (b.style?.palette?.length) L.push(`Palette: ${b.style.palette.join(", ")}${b.style.typography ? ` · Type: ${b.style.typography}` : ""}`);
  if (b.voice) L.push(`Voice: ${b.voice}`);
  for (const pg of b.pages) L.push(`• ${pg.brief} — ${pg.versionId} · ${pg.previewUrl}`);
  for (const d of b.decisions.slice(-5)) L.push(`• rule: ${d.summary} _(${d.requestedBy.join(", ") || "team"})_`);
  const people = Object.values(b.people);
  if (people.length) L.push(`People: ${people.map((x) => `${x.name}${x.role ? ` (${x.role})` : ""}`).join(", ")}`);
  return L.join("\n");
}
