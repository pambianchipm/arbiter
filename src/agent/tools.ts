import type Anthropic from "@anthropic-ai/sdk";
import type { Store } from "../store.js";
import type { Screenshotter } from "../render/screenshot.js";
import type { Surface } from "../surface.js";
import type { Brand, Fork, Project, Question, Role, TurnResult, Version } from "../types.js";
import { nextVersionNumber, nowIso, shortId, ROLES } from "../types.js";
import { log, errMsg } from "../log.js";
import { buildHandoffFiles } from "../handoff.js";
import { assertPublicHttpUrl } from "../net.js";

export interface ToolContext {
  project: Project;
  store: Store;
  shots: Screenshotter;
  surface: Surface;
  baseUrl: string;
  result: TurnResult;
  renderRetries: number;
  brand?: Brand;
  /** spend n renders from the server's allowance; ok=false means stop and tell the team */
  meter: (n: number) => Promise<{ ok: boolean; remaining: number; reason?: string }>;
  /** "?k=<token>" when hosted previews are tokenised, else "" */
  urlSuffix: string;
  onVersionPublished?: (v: Version) => void;
  onForkOpened?: (f: Fork) => void;
}

type ToolOutput = { content: string | Anthropic.Beta.BetaToolResultBlockParam["content"]; isError?: boolean };

const ok = (data: unknown): ToolOutput => ({ content: typeof data === "string" ? data : JSON.stringify(data) });
const fail = (msg: string): ToolOutput => {
  log.warn("tool result is_error:", msg);
  return { content: msg, isError: true };
};

export const TOOL_DEFS: Anthropic.Beta.BetaTool[] = [
  {
    name: "publish_version",
    description:
      "Save a new prototype version, render it, and post the screenshot + live link to the thread. Fails if a fork vote is open. Returns render warnings (console/page errors) you should fix if they indicate a real bug.",
    input_schema: {
      type: "object",
      properties: {
        html: { type: "string", description: "Complete single-file HTML document. No markdown fences." },
        summary: { type: "string", description: "One sentence: what this version is." },
        changes: { type: "array", items: { type: "string" }, description: "Short bullets of what changed vs the previous version (empty for v1)." },
        addresses: { type: "array", items: { type: "string" }, description: "Names of the people whose feedback this version acts on." },
      },
      required: ["html", "summary", "changes", "addresses"],
    },
  },
  {
    name: "fork_variants",
    description:
      "Open an A/B vote because two people asked for incompatible things. Builds both variants, renders them side by side, and posts vote buttons. One variant per position; each must be faithful to its author. For each side give EITHER html OR reuse_version (an existing version id, e.g. the current version when one person wants it kept as-is). Prefer reuse_version whenever a side is an existing version: it is faster and cannot be truncated. Only one fork can be open at a time.",
    input_schema: {
      type: "object",
      properties: {
        question: { type: "string", description: "The vote question, naming the disagreement plainly." },
        a: {
          type: "object",
          properties: {
            label: { type: "string", description: "3-6 word label" },
            champion: { type: "string", description: "Name of the person this variant is faithful to" },
            rationale: { type: "string", description: "One sentence on what this variant optimises for" },
            html: { type: "string", description: "Complete HTML for this side. Omit when reuse_version is set." },
            reuse_version: { type: "string", description: "Existing version id to use unchanged for this side, e.g. \"v2\"." },
          },
          required: ["label", "champion", "rationale"],
        },
        b: {
          type: "object",
          properties: {
            label: { type: "string" },
            champion: { type: "string" },
            rationale: { type: "string" },
            html: { type: "string" },
            reuse_version: { type: "string" },
          },
          required: ["label", "champion", "rationale"],
        },
      },
      required: ["question", "a", "b"],
    },
  },
  {
    name: "ask",
    description: "Post a pointed question to specific people. 'to' is a role (designer|pm|eng|stakeholder), 'everyone', or a person's name. Use at most twice per turn.",
    input_schema: {
      type: "object",
      properties: {
        to: { type: "string" },
        question: { type: "string" },
      },
      required: ["to", "question"],
    },
  },
  {
    name: "log_decision",
    description: "Record an accepted change in the decision log with provenance (who asked, why). Call once per accepted change.",
    input_schema: {
      type: "object",
      properties: {
        summary: { type: "string" },
        requested_by: { type: "array", items: { type: "string" }, description: "Names" },
        rationale: { type: "string" },
        version_id: { type: "string", description: "Version this landed in, if any" },
      },
      required: ["summary", "requested_by", "rationale"],
    },
  },
  {
    name: "add_constraint",
    description: "Record a hard constraint stated by the team (usually engineering): components that don't exist, brand rules, legal copy, etc. Constraints apply to every future version.",
    input_schema: {
      type: "object",
      properties: {
        text: { type: "string" },
        source: { type: "string", description: "Name of the person who stated it" },
      },
      required: ["text", "source"],
    },
  },
  {
    name: "study_reference",
    description: "Screenshot an external website so you can see its design. Returns the image. Use when someone says 'make it feel like <url>'. Follow with set_style.",
    input_schema: {
      type: "object",
      properties: { url: { type: "string" } },
      required: ["url"],
    },
  },
  {
    name: "set_style",
    description: "Persist style notes (from a reference or from the team's stated taste) so every future version follows them.",
    input_schema: {
      type: "object",
      properties: {
        source: { type: "string", description: "URL or person" },
        summary: { type: "string" },
        palette: { type: "array", items: { type: "string" }, description: "hex colours" },
        typography: { type: "string" },
        spacing: { type: "string" },
        vibe: { type: "string" },
      },
      required: ["summary"],
    },
  },
  {
    name: "remember_for_brand",
    description:
      "Record something that should hold on EVERY page of this brand, not just this one: a rule ('primary CTA is always rust'), a voice note ('never say cheap, say honest'), or a cross-page decision. Stored in the server's brand memory with provenance.",
    input_schema: {
      type: "object",
      properties: {
        summary: { type: "string" },
        requested_by: { type: "array", items: { type: "string" } },
        rationale: { type: "string" },
        voice: { type: "string", description: "Optional: replace the brand's copy/voice guideline with this sentence." },
      },
      required: ["summary", "requested_by", "rationale"],
    },
  },
  {
    name: "post_handoff",
    description:
      "Post the handoff package to the thread as a zip: BUILD.md (a brief for a coding agent), the decision log, index.html, the screenshot, and the brand's shared chrome and other pages when there is brand memory. Call this when someone asks for the handoff, the spec, the deliverable, the files, the zip, or the source. Optional stack targets BUILD.md (e.g. 'Next.js + Tailwind').",
    input_schema: {
      type: "object",
      properties: { stack: { type: "string" } },
    },
  },
  {
    name: "say",
    description: "Post a short status line to the thread (e.g. 'Conflict: Sam wants more whitespace, Priya wants denser. Forking.'). Keep it to one or two sentences.",
    input_schema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
  },
];

export async function executeTool(name: string, rawInput: unknown, ctx: ToolContext): Promise<ToolOutput> {
  const input = (rawInput ?? {}) as Record<string, unknown>;
  try {
    switch (name) {
      case "publish_version":
        return await publishVersion(input, ctx);
      case "fork_variants":
        return await forkVariants(input, ctx);
      case "ask":
        return await ask(input, ctx);
      case "log_decision":
        return await logDecision(input, ctx);
      case "add_constraint":
        return await addConstraint(input, ctx);
      case "study_reference":
        return await studyReference(input, ctx);
      case "set_style":
        return await setStyle(input, ctx);
      case "say":
        return await say(input, ctx);
      case "post_handoff":
        return await postHandoff(input, ctx);
      case "remember_for_brand":
        return await rememberForBrand(input, ctx);
      default:
        return fail(`Unknown tool ${name}`);
    }
  } catch (e) {
    log.error(`tool ${name} threw`, errMsg(e));
    return fail(`Tool ${name} failed: ${errMsg(e)}`);
  }
}

// ---------------------------------------------------------------------------

export function cleanHtml(raw: unknown): string {
  let s = String(raw ?? "").trim();
  const fence = /^```(?:html)?\s*\n([\s\S]*?)\n```$/i.exec(s);
  if (fence) s = fence[1].trim();
  return s;
}

function validateHtml(html: string): string | undefined {
  if (html.length < 200) return "html is too short to be a full document";
  if (html.length > 400_000) return "html is too large (>400KB)";
  if (!/<html[\s>]/i.test(html) || !/<\/html>/i.test(html)) return "html must be a complete document with <html> … </html>";
  if (!/<body[\s>]/i.test(html)) return "html must contain a <body>";
  return undefined;
}

function pushAgentNote(p: Project, text: string): void {
  p.transcript.push({ id: shortId("t_"), at: nowIso(), kind: "agent", name: "Arbiter", text, seen: true });
}

async function publishVersion(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutput> {
  const p = ctx.project;
  if (p.fork && !p.fork.resolved) {
    return fail(`Fork ${p.fork.id} is still open ("${p.fork.question}"). You cannot publish a single version while a conflict is unresolved. Wait for the vote.`);
  }
  const html = cleanHtml(input.html);
  const bad = validateHtml(html);
  if (bad) return fail(`Invalid html: ${bad}. Fix and call publish_version again.`);
  const credit = await ctx.meter(1);
  if (!credit.ok) return fail(`OUT OF RENDERS: ${credit.reason ?? "this server has used its allowance"}. Do not retry. Tell the team plainly that the server is out of renders and that /plan shows how to add more.`);

  const id = `v${nextVersionNumber(p)}`;
  await ctx.store.writeHtml(p.id, id, html);
  const url = `${ctx.baseUrl}/p/${p.id}/${id}${ctx.urlSuffix}`;
  // Screenshots always go through the local listener, whatever the public URL is.
  const shotUrl = `${localBase(ctx)}/p/${p.id}/${id}${ctx.urlSuffix}`;

  let shot;
  try {
    shot = await ctx.shots.shoot(shotUrl);
  } catch (e) {
    return fail(`Render failed for ${id}: ${errMsg(e)}. Check the HTML for a syntax problem and call publish_version again.`);
  }
  const expectedTitle = /<title>([^<]*)<\/title>/i.exec(html)?.[1]?.trim();
  if (expectedTitle && shot.title.trim() !== expectedTitle) {
    return fail(`Render of ${id} captured the wrong page (title "${shot.title}" instead of "${expectedTitle}"). This is an infrastructure problem (preview server or proxy), not your HTML; tell the team and stop.`);
  }
  const pageErrors = shot.warnings.filter((w) => w.startsWith("page error"));
  if (pageErrors.length && ctx.renderRetries < 1) {
    ctx.renderRetries++;
    return fail(`${id} rendered but threw JavaScript errors: ${pageErrors.join("; ")}. Fix them and call publish_version again (the broken version was NOT posted).`);
  }
  const overflow = shot.warnings.find((w) => w.startsWith("horizontal overflow at"));
  if (overflow && ctx.renderRetries < 1) {
    ctx.renderRetries++;
    return fail(
      `${id} scrolls sideways: ${overflow}. Something is wider than the viewport (a decorative blob, a fixed pixel width, a grid that doesn't collapse). Put decorative elements inside a relative parent with overflow-hidden, drop fixed widths, and call publish_version again (the broken version was NOT posted).`,
    );
  }

  await ctx.store.writePng(p.id, id, shot.png);
  const version: Version = {
    id,
    parent: p.currentVersionId,
    summary: String(input.summary ?? "").slice(0, 300),
    changes: toStrArr(input.changes),
    addresses: toStrArr(input.addresses),
    createdAt: nowIso(),
    previewUrl: url,
    approvals: [],
    renderWarnings: shot.warnings.length ? shot.warnings : undefined,
  };
  p.versions.push(version);
  p.currentVersionId = id;
  p.nudgedFor = undefined;
  await ctx.store.save(p);

  const posted = await ctx.surface.postVersion(p, version, shot.png);
  version.messageId = posted.messageId;
  pushAgentNote(p, `Published ${id}: ${version.summary}${version.changes.length ? ` (changes: ${version.changes.join("; ")})` : ""}`);
  await ctx.store.save(p);
  ctx.result.publishedVersionIds.push(id);
  ctx.onVersionPublished?.(version);
  log.info(`published ${p.id}/${id} in ${shot.ms}ms, warnings=${shot.warnings.length}`);
  return ok({ versionId: id, previewUrl: url, renderWarnings: shot.warnings });
}

async function forkVariants(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutput> {
  const p = ctx.project;
  if (p.fork && !p.fork.resolved) return fail(`Fork ${p.fork.id} is already open. Resolve it before opening another.`);
  const a = (input.a ?? {}) as Record<string, unknown>;
  const b = (input.b ?? {}) as Record<string, unknown>;
  const resolveSide = async (side: Record<string, unknown>, name: string): Promise<{ html?: string; error?: string }> => {
    if (side.reuse_version) {
      const id = String(side.reuse_version);
      if (!p.versions.some((v) => v.id === id)) return { error: `${name}: reuse_version "${id}" does not exist (versions: ${p.versions.map((v) => v.id).join(", ")})` };
      const html = await ctx.store.readHtml(p.id, id);
      return html ? { html } : { error: `${name}: could not read ${id}` };
    }
    const html = cleanHtml(side.html);
    const bad = validateHtml(html);
    return bad ? { error: `${name}: ${bad} (pass reuse_version instead if this side is an existing version)` } : { html };
  };
  const [ra, rb] = await Promise.all([resolveSide(a, "A"), resolveSide(b, "B")]);
  if (ra.error || rb.error) return fail(`Invalid fork: ${[ra.error, rb.error].filter(Boolean).join("; ")}`);
  const credit = await ctx.meter(2);
  if (!credit.ok) return fail(`OUT OF RENDERS: ${credit.reason ?? "this server has used its allowance"}. Do not retry. Tell the team plainly that the server is out of renders and that /plan shows how to add more.`);
  const htmlA = ra.html!;
  const htmlB = rb.html!;

  const n = nextVersionNumber(p);
  const idA = `v${n}a`;
  const idB = `v${n}b`;
  await ctx.store.writeHtml(p.id, idA, htmlA);
  await ctx.store.writeHtml(p.id, idB, htmlB);
  const compareLocal = `${localBase(ctx)}/p/${p.id}/compare/${idA}/${idB}${ctx.urlSuffix}`;
  let shot;
  try {
    shot = await ctx.shots.shoot(compareLocal, { width: 2600, height: 900, scale: 1, checkMobile: false });
  } catch (e) {
    return fail(`Render failed for the comparison: ${errMsg(e)}. Check both HTML documents and call fork_variants again.`);
  }
  const forkId = `f${n}`;
  await ctx.store.writePng(p.id, forkId, shot.png);
  const mk = (id: string, side: Record<string, unknown>): Version => ({
    id,
    parent: p.currentVersionId,
    label: String(side.label ?? id).slice(0, 80),
    summary: String(side.rationale ?? "").slice(0, 300),
    changes: [],
    addresses: side.champion ? [String(side.champion)] : [],
    createdAt: nowIso(),
    previewUrl: `${ctx.baseUrl}/p/${p.id}/${id}${ctx.urlSuffix}`,
    approvals: [],
  });
  const vA = mk(idA, a);
  const vB = mk(idB, b);
  p.versions.push(vA, vB);
  const fork: Fork = {
    id: forkId,
    question: String(input.question ?? "").slice(0, 400),
    a: { versionId: idA, label: vA.label ?? idA, rationale: vA.summary, champion: a.champion ? String(a.champion) : undefined },
    b: { versionId: idB, label: vB.label ?? idB, rationale: vB.summary, champion: b.champion ? String(b.champion) : undefined },
    votes: {},
    openedAt: nowIso(),
  };
  p.fork = fork;
  await ctx.store.save(p);
  const posted = await ctx.surface.postFork(p, fork, shot.png);
  fork.messageId = posted.messageId;
  pushAgentNote(p, `Opened fork ${forkId}: "${fork.question}" — A "${fork.a.label}" (${fork.a.champion ?? "?"}) vs B "${fork.b.label}" (${fork.b.champion ?? "?"})`);
  await ctx.store.save(p);
  ctx.result.forkOpened = forkId;
  ctx.onForkOpened?.(fork);
  return ok({ forkId, a: idA, b: idB, compareUrl: `${ctx.baseUrl}/p/${p.id}/compare/${idA}/${idB}${ctx.urlSuffix}` });
}

export function resolveMentionTargets(p: Project, to: string): string[] {
  const t = to.trim().toLowerCase();
  const all = Object.values(p.participants);
  if (t === "everyone" || t === "all" || t === "team") return all.map((x) => x.id);
  if ((ROLES as string[]).includes(t)) return all.filter((x) => x.role === (t as Role)).map((x) => x.id);
  const byName = all.filter((x) => x.name.toLowerCase() === t || x.name.toLowerCase().startsWith(t));
  return byName.map((x) => x.id);
}

async function ask(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutput> {
  const p = ctx.project;
  const q: Question = { id: shortId("q_"), at: nowIso(), text: String(input.question ?? "").slice(0, 600), to: String(input.to ?? "everyone") };
  p.questions.push(q);
  const targets = resolveMentionTargets(p, q.to);
  await ctx.surface.postQuestion(p, q, targets);
  pushAgentNote(p, `Asked ${q.to}: ${q.text}`);
  await ctx.store.save(p);
  return ok({ asked: q.to, mentioned: targets.length });
}

async function logDecision(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutput> {
  const p = ctx.project;
  p.decisions.push({
    id: shortId("d_"),
    at: nowIso(),
    summary: String(input.summary ?? "").slice(0, 400),
    rationale: String(input.rationale ?? "").slice(0, 600),
    requestedBy: toStrArr(input.requested_by),
    versionId: input.version_id ? String(input.version_id) : p.currentVersionId,
  });
  await ctx.store.save(p);
  return ok({ logged: p.decisions.length });
}

async function addConstraint(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutput> {
  const p = ctx.project;
  const text = String(input.text ?? "").trim().slice(0, 400);
  if (!text) return fail("constraint text is empty");
  if (p.constraints.some((c) => c.text.toLowerCase() === text.toLowerCase())) return ok({ duplicate: true });
  p.constraints.push({ id: shortId("c_"), text, source: String(input.source ?? "team"), at: nowIso() });
  await ctx.store.save(p);
  return ok({ constraints: p.constraints.length });
}

async function studyReference(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutput> {
  const url = String(input.url ?? "").trim();
  if (!/^https?:\/\//i.test(url)) return fail("url must start with http:// or https://");
  try {
    await assertPublicHttpUrl(url);
  } catch (e) {
    return fail(`Can't load ${url}: ${errMsg(e)}. Tell the team and proceed from the brief.`);
  }
  try {
    const shot = await ctx.shots.shootExternal(url);
    return {
      content: [
        { type: "text", text: `Screenshot of ${url} (1280×900). Extract palette, type, spacing and vibe, then call set_style.` },
        { type: "image", source: { type: "base64", media_type: "image/png", data: shot.png.toString("base64") } },
      ],
    };
  } catch (e) {
    return fail(`Could not load ${url}: ${errMsg(e)}. Proceed from the brief and tell the team the reference could not be loaded.`);
  }
}

async function setStyle(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutput> {
  const p = ctx.project;
  p.style = {
    source: input.source ? String(input.source) : p.style?.source,
    summary: String(input.summary ?? "").slice(0, 800),
    palette: input.palette ? toStrArr(input.palette) : p.style?.palette,
    typography: input.typography ? String(input.typography) : p.style?.typography,
    spacing: input.spacing ? String(input.spacing) : p.style?.spacing,
    vibe: input.vibe ? String(input.vibe) : p.style?.vibe,
  };
  await ctx.store.save(p);
  return ok({ saved: true });
}

async function say(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutput> {
  const text = String(input.text ?? "").trim().slice(0, 1500);
  if (!text) return fail("nothing to say");
  await ctx.surface.postText(ctx.project, text);
  pushAgentNote(ctx.project, text);
  await ctx.store.save(ctx.project);
  return ok({ posted: true });
}

async function rememberForBrand(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutput> {
  const b = ctx.brand;
  if (!b) return fail("This thread has no brand memory (no server). Use log_decision for page-level decisions.");
  b.decisions.push({
    id: shortId("d_"),
    at: nowIso(),
    summary: String(input.summary ?? "").slice(0, 400),
    rationale: String(input.rationale ?? "").slice(0, 600),
    requestedBy: toStrArr(input.requested_by),
    versionId: ctx.project.currentVersionId,
  });
  if (input.voice) b.voice = String(input.voice).slice(0, 400);
  await ctx.store.saveBrand(b);
  pushAgentNote(ctx.project, `Remembered for the ${b.name} brand: ${String(input.summary ?? "")}`);
  await ctx.store.save(ctx.project);
  return ok({ brandRules: b.decisions.length });
}

async function postHandoff(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutput> {
  const p = ctx.project;
  if (!p.versions.length) return fail("Nothing to hand off yet: no version has been published.");
  const stack = input.stack ? String(input.stack).slice(0, 120) : undefined;
  const { files, text } = await buildHandoffFiles(ctx.store, p, stack, ctx.brand);
  await ctx.surface.postFiles(p, files, text);
  pushAgentNote(p, `Posted the handoff package (${files.map((f) => f.name).join(", ")}).`);
  await ctx.store.save(p);
  return ok({ posted: files.map((f) => f.name) });
}

function toStrArr(v: unknown): string[] {
  return Array.isArray(v) ? v.map((x) => String(x)).filter(Boolean) : [];
}

function localBase(ctx: ToolContext): string {
  const u = new URL(ctx.baseUrl);
  if (u.hostname === "localhost" || u.hostname === "127.0.0.1") return ctx.baseUrl;
  // Public URL is a tunnel; screenshots still go to the local listener.
  return `http://localhost:${process.env.PORT || 3939}`;
}
