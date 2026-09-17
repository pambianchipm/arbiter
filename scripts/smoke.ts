/**
 * End-to-end smoke test with a scripted fake model: exercises the orchestrator,
 * tool execution, preview server, Playwright screenshots, votes, approval, and
 * handoff — everything except the live Claude call. Run: npm run smoke
 */
import type Anthropic from "@anthropic-ai/sdk";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { Store } from "../src/store.js";
import { createPreviewServer, listen } from "../src/render/server.js";
import { Screenshotter } from "../src/render/screenshot.js";
import { Agent } from "../src/agent/run.js";
import { Orchestrator } from "../src/orchestrator.js";
import { ConsoleSurface } from "./console-surface.js";
import type { Project } from "../src/types.js";
import type { ToolContext } from "../src/agent/tools.js";
import { HTML_V1, HTML_V2A, HTML_V2B, HTML_V3 } from "./fixtures.js";

type Block = Anthropic.Beta.BetaContentBlock;

function toolUse(name: string, input: unknown): Block {
  return { type: "tool_use", id: `tu_${Math.random().toString(36).slice(2, 8)}`, name, input } as Block;
}
function text(t: string): Block {
  return { type: "text", text: t, citations: null } as unknown as Block;
}
function msg(content: Block[], stop: "tool_use" | "end_turn"): Anthropic.Beta.BetaMessage {
  return { id: "msg_fake", type: "message", role: "assistant", model: "fake", content, stop_reason: stop, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } as unknown as Anthropic.Beta.BetaMessage;
}

class FakeClient {
  public calls: Array<{ messages: Anthropic.Beta.BetaMessageParam[] }> = [];
  private queue: Anthropic.Beta.BetaMessage[] = [];
  push(...m: Anthropic.Beta.BetaMessage[]): void {
    this.queue.push(...m);
  }
  beta = {
    messages: {
      stream: (params: { messages: Anthropic.Beta.BetaMessageParam[] }) => {
        this.calls.push({ messages: params.messages });
        const next = this.queue.shift();
        return {
          finalMessage: async () => {
            if (!next) throw new Error("fake model: no scripted response left");
            return next;
          },
        };
      },
    },
  };
}

async function waitFor(label: string, fn: () => Promise<boolean> | boolean, timeoutMs = 60_000): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timeout waiting for: ${label}`);
}

function assert(cond: unknown, label: string): void {
  if (!cond) throw new Error(`ASSERT FAILED: ${label}`);
  console.log(`  ✓ ${label}`);
}

async function main(): Promise<void> {
  // Discord validates slash-command shapes at import time (name ≤32, descriptions ≤100, etc.).
  console.log("▶ slash commands");
  const { commands } = await import("../src/discord/commands.js");
  for (const c of commands) {
    assert(c.description.length <= 100, `/${c.name} description ≤100 chars (${c.description.length})`);
    for (const o of c.options ?? []) assert(o.description.length <= 100, `/${c.name} ${o.name} option description ≤100 chars`);
  }

  console.log("▶ voice utils");
  const audio = await import("../src/voice/audio.js");
  const frames = 48_000; // 1s of 48k stereo
  const pcm = Buffer.alloc(frames * 4);
  for (let i = 0; i < frames; i++) {
    const v = Math.round(Math.sin((2 * Math.PI * 440 * i) / 48_000) * 12_000);
    pcm.writeInt16LE(v, i * 4);
    pcm.writeInt16LE(v, i * 4 + 2);
  }
  const wav = audio.pcm48kStereoToWav16kMono(pcm);
  assert(wav.toString("ascii", 0, 4) === "RIFF" && wav.toString("ascii", 8, 12) === "WAVE", "wav header");
  assert(wav.readUInt32LE(24) === 16_000 && wav.readUInt16LE(22) === 1 && wav.length === 44 + 16_000 * 2, "1s of 48k stereo → 1s of 16k mono");
  assert(Math.abs(audio.durationSeconds48kStereo(pcm) - 1) < 1e-9, "duration computed from pcm length");
  assert(audio.looksLikeHallucination("Thank you.") && audio.looksLikeHallucination("you") && !audio.looksLikeHallucination("more whitespace in the hero"), "hallucination filter");
  const gate = await import("../src/voice/gate.js");
  assert(gate.rmsLevel(pcm) > 8000 && gate.rmsLevel(Buffer.alloc(4000)) === 0, "rms level: tone loud, silence zero");
  assert(gate.addressedToArbiter("hey Arbiter, make the hero denser") === "make the hero denser" && gate.addressedToArbiter("where's the coffee") === undefined, "address mode strips the name and rejects unaddressed lines");
  const vm = await import("../src/voice/manager.js");
  assert(typeof vm.VoiceManager === "function", "voice manager module loads (opus + DAVE deps resolve)");
  const stt = await import("../src/voice/stt.js");
  assert(stt.pickSTT({ preference: "auto", elevenLabsKey: "x" })?.name === "elevenlabs-scribe" && stt.pickSTT({ preference: "auto", openaiKey: "y" })?.name === "openai-whisper" && stt.pickSTT({ preference: "off", elevenLabsKey: "x" }) === undefined, "stt provider selection");

  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "arbiter-smoke-"));
  const store = new Store(dataDir);
  await store.init();
  const server = await listen(createPreviewServer(store), 0);
  const port = (server.address() as AddressInfo).port;
  const baseUrl = `http://localhost:${port}`;
  process.env.PORT = String(port);
  const shots = new Screenshotter(process.env.CHROMIUM_PATH || undefined);
  const fake = new FakeClient();
  const agent = new Agent(fake as unknown as Anthropic, { model: "fake", effort: "low", fastMode: false, maxIterations: 6, fallbacks: false });
  const surface = new ConsoleSurface();
  const orch = new Orchestrator(store, shots, surface, agent, { baseUrl, debounceMs: 200, nudgeMinutes: 0, forkTimeoutMinutes: 0 });

  // ---- Turn 1: kickoff → publish v1 + ask designer
  fake.push(
    msg([toolUse("publish_version", { html: HTML_V1, summary: "Hero + three value props for Ember coffee subscription", changes: [], addresses: ["Priya"] }), toolUse("ask", { to: "designer", question: "I went warm amber on stone. Sam, is that the palette you had in mind?" })], "tool_use"),
    msg([text("v1 is up. Sam, palette check; Priya, is price the first thing a visitor should see?")], "end_turn"),
  );
  console.log("\n▶ turn 1: kickoff");
  const threadId = "thread_smoke";
  await orch.startProject({ threadId, channelId: "chan", guildId: "guild", brief: "landing page for a coffee subscription", createdBy: { id: "u_priya", name: "Priya", role: "pm" } });
  await waitFor("turn 1", async () => (await store.load(threadId))?.turnCount === 1);
  let p = (await store.load(threadId))!;
  assert(p.versions.length === 1 && p.currentVersionId === "v1", "v1 published and current");
  assert((await store.readHtml(threadId, "v1"))?.includes("Ember"), "v1 html stored");
  const png1 = await store.readPng(threadId, "v1");
  assert(png1 && png1.length > 10_000, `v1 screenshot rendered (${png1?.length} bytes)`);
  const direct = await shots.shoot(`${baseUrl}/p/${threadId}/v1`);
  assert(direct.title === "Ember — coffee, delivered", `screenshot captured the served page (title "${direct.title}")`);
  assert(!direct.warnings.some((w) => w.includes("horizontal overflow")), "fixture page has no sideways scroll");
  await store.writeHtml(threadId, "wide", HTML_V1.replace("<main", '<div style="width:3000px;height:10px"></div><main'));
  const wide = await shots.shoot(`${baseUrl}/p/${threadId}/wide`);
  assert(wide.warnings.some((w) => w.startsWith("horizontal overflow at 1280px")) && wide.warnings.some((w) => w.includes("on mobile")), "renderer detects sideways scroll at desktop and phone widths");
  const tailwindLoaded = await (async () => {
    const r = await fetch(`${baseUrl}/p/${threadId}/v1`);
    return r.ok;
  })();
  assert(tailwindLoaded, "preview reachable");
  assert(p.questions.length === 1 && p.questions[0].to === "designer", "question logged for designer");
  assert(surface.log.some((l) => l.startsWith("📐 v1")), "version posted to surface");
  const res = await fetch(`${baseUrl}/p/${threadId}/v1`);
  assert(res.status === 200 && (await res.text()).includes("<html"), "preview server serves v1");
  const warn = p.versions[0].renderWarnings ?? [];
  console.log(`  ℹ render warnings: ${warn.length ? warn.join(" | ") : "none"}`);

  // ---- Turn 2: conflicting feedback → fork
  fake.push(
    msg([toolUse("say", { text: "Conflict: Sam wants more whitespace, Priya wants it denser with social proof. Forking." }), toolUse("fork_variants", { question: "Airy hero or denser hero with social proof?", a: { label: "Airy, more whitespace", champion: "Sam", rationale: "Lets the headline breathe", reuse_version: "v1" }, b: { label: "Denser + social proof", champion: "Priya", rationale: "Proof above the fold", html: HTML_V2B } })], "tool_use"),
    msg([text("Two variants are up. Vote A or B.")], "end_turn"),
  );
  console.log("\n▶ turn 2: conflicting feedback");
  await orch.addHumanMessage(threadId, { userId: "u_sam", name: "Sam", role: "designer", text: "way more whitespace in the hero please" });
  await orch.addHumanMessage(threadId, { userId: "u_priya", name: "Priya", text: "denser — and add social proof above the fold" });
  await waitFor("turn 2", async () => (await store.load(threadId))?.turnCount === 2);
  p = (await store.load(threadId))!;
  assert(fake.calls.length === 4, "two messages were batched into ONE turn (debounce)");
  const t2 = fake.calls[2].messages[0].content;
  const t2text = typeof t2 === "string" ? t2 : t2.map((b) => (b.type === "text" ? b.text : "")).join("\n");
  assert(t2text.includes("NEW") && t2text.includes("Sam (designer)") && t2text.includes("Priya (pm)"), "turn prompt attributes both asks with roles");
  assert(t2text.includes("<html"), "turn prompt carries current version html");
  assert(p.fork && !p.fork.resolved && p.fork.id === "f2", "fork f2 is open");
  assert(p.versions.map((v) => v.id).join(",") === "v1,v2a,v2b", "variants v2a/v2b stored");
  assert((await store.readHtml(threadId, "v2a")) === (await store.readHtml(threadId, "v1")), "reuse_version copied v1's html into v2a");
  const cmp = await fetch(`${baseUrl}/p/${threadId}/compare/v2a/v2b`);
  assert(cmp.status === 200, "compare page served");
  const pngF = await store.readPng(threadId, "f2");
  assert(pngF && pngF.length > 10_000, `side-by-side screenshot rendered (${pngF?.length} bytes)`);
  assert(p.questions[0].answered === true, "designer's reply marked the open question answered");

  // publish while fork open must be refused
  fake.push(msg([toolUse("publish_version", { html: HTML_V3, summary: "sneaky", changes: [], addresses: [] })], "tool_use"), msg([text("ok")], "end_turn"));
  await orch.addHumanMessage(threadId, { userId: "u_lee", name: "Lee", role: "eng", text: "fyi we don't have a carousel component" });
  await waitFor("turn 2b", async () => (await store.load(threadId))?.turnCount === 3);
  p = (await store.load(threadId))!;
  assert(p.versions.length === 3, "publish_version refused while fork open");
  const refusal = fake.calls[fake.calls.length - 1].messages[2].content;
  assert(Array.isArray(refusal) && refusal[0].type === "tool_result" && refusal[0].is_error === true, "model received is_error tool result");

  // ---- Votes → auto-resolve when everyone voted → Turn 3 builds winner
  fake.push(
    msg([toolUse("publish_version", { html: HTML_V3, summary: "Airy hero (A won 2–1)", changes: ["Hero padding increased", "Kept three value props"], addresses: ["Sam", "Priya", "Lee"] }), toolUse("log_decision", { summary: "Airy hero over dense hero", requested_by: ["Sam"], rationale: "A won the vote 2–1", version_id: "v3" }), toolUse("add_constraint", { text: "No carousel component exists", source: "Lee" }), toolUse("post_handoff", { stack: "Next.js + Tailwind" })], "tool_use"),
    msg([text("v3 is the airy hero. Lee, noted: no carousels.")], "end_turn"),
  );
  console.log("\n▶ turn 3: votes");
  let r = await orch.vote(threadId, "f2", "u_sam", "Sam", "a");
  assert(r.ok && !r.resolved, "first vote recorded, not resolved yet");
  r = await orch.vote(threadId, "f2", "u_lee", "Lee", "a");
  assert(r.ok && !r.resolved, "second vote recorded, still waiting on Priya");
  r = await orch.vote(threadId, "f2", "u_priya", "Priya", "b");
  assert(r.ok && r.resolved === true, "everyone voted → auto-resolved");
  await waitFor("turn 3", async () => (await store.load(threadId))?.turnCount === 4);
  p = (await store.load(threadId))!;
  assert(!p.fork && p.forkHistory.length === 1 && p.forkHistory[0].resolved?.winner === "a", "fork moved to history with winner A");
  assert(p.currentVersionId === "v3", "v3 built from the winner");
  assert(p.decisions.length === 1 && p.constraints.length === 1, "decision + constraint logged");
  assert(surface.log.some((l) => l.includes("Handoff for") && l.includes(".zip") && l.includes("Next.js + Tailwind")), "agent's post_handoff tool posted the zip with the stack");
  const t3 = fake.calls[fake.calls.length - 2].messages[0].content;
  const t3text = typeof t3 === "string" ? t3 : t3.map((b) => (b.type === "text" ? b.text : "")).join("\n");
  assert(/fork f2 resolved .* A \(A 2, B 1\)/.test(t3text), "turn prompt carries the tally");

  // ---- Approvals → shipped → handoff
  console.log("\n▶ approvals + handoff");
  for (const [id, name] of [["u_sam", "Sam"], ["u_priya", "Priya"], ["u_lee", "Lee"]] as const) {
    const a = await orch.approve(threadId, "v3", id, name);
    assert(a.ok, `${name} approved (${a.count}/${a.total})`);
  }
  p = (await store.load(threadId))!;
  assert(p.status === "shipped", "all approvals → shipped");
  assert(await orch.handoff(threadId), "handoff posted");
  const last = surface.log[surface.log.length - 1];
  assert(last.includes("arbiter-landing-page-for-a-coffee-subscription.zip") && last.includes("v3.png"), "handoff posts one zip plus the screenshot");
  {
    const { buildHandoffFiles } = await import("../src/handoff.js");
    const { unzipSync } = await import("fflate");
    const built = await buildHandoffFiles(store, p, "Next.js + Tailwind", await store.loadBrand("guild", "default"));
    const names = Object.keys(unzipSync(new Uint8Array(built.files[0].data)));
    for (const want of ["README.md", "BUILD.md", "handoff.md", "index.html", "screenshot.png", "brand/brand.md", "brand/header.html", "brand/footer.html"]) assert(names.includes(want), `zip contains ${want}`);
  }
  const { generateBuildBrief } = await import("../src/handoff.js");
  const brief = generateBuildBrief(p, "Next.js + Tailwind");
  assert(brief.includes("Next.js + Tailwind") && brief.includes("No carousel component exists") && brief.includes("Airy hero over dense hero") && brief.includes("Do not reopen"), "BUILD.md carries stack, constraints, decisions, settled forks");

  // ---- Live canvas
  console.log("\n▶ live canvas");
  const idx = await fetch(`${baseUrl}/live`);
  assert(idx.status === 200 && (await idx.text()).includes(`/live/${threadId}`), "index lists the session with a live link");
  const live = await fetch(`${baseUrl}/live/${threadId}`);
  assert(live.status === 200 && (await live.text()).includes("EventSource"), "live page served");
  const st = (await (await fetch(`${baseUrl}/live/${threadId}/state`)).json()) as { current: { id: string }; status: string; fork: unknown };
  assert(st.current.id === "v3" && st.status === "shipped" && st.fork === null, "live state reflects v3 / shipped / no open fork");
  const sseGot = await new Promise<boolean>((resolve) => {
    const ctl = new AbortController();
    fetch(`${baseUrl}/live/${threadId}/events`, { signal: ctl.signal }).then(async (r) => {
      const reader = r.body!.getReader();
      const dec = new TextDecoder();
      let buf = "";
      setTimeout(() => void store.save(p), 150); // trigger a change event
      const t = setTimeout(() => { ctl.abort(); resolve(false); }, 5000);
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value);
        if (buf.includes("data: change")) { clearTimeout(t); ctl.abort(); resolve(true); break; }
      }
    }).catch(() => resolve(buf_never()));
    function buf_never() { return false; }
  });
  assert(sseGot, "SSE pushes a change event when state is saved");

  // ---- Brand memory: shipping absorbed chrome + tokens; the next project on this server starts from it
  console.log("\n▶ brand memory");
  const brand = await store.loadBrand("guild", "default");
  assert(brand && brand.pages.length === 1 && brand.pages[0].threadId === threadId, "shipping created the server's default brand with one page");
  assert(brand!.chrome?.header?.startsWith("<header") && brand!.chrome?.footer?.startsWith("<footer") && brand!.chrome?.head?.includes("tailwindcss"), "header/footer/head extras lifted from the approved page");
  assert(brand!.constraints.length === 1 && brand!.people["u_sam"]?.role === "designer", "constraints and people folded into the brand");
  assert(brand!.pages[0].previewUrl.endsWith("/current"), "site map uses stable /current links");
  const cur = await fetch(`${baseUrl}/p/${threadId}/current`, { redirect: "manual" });
  assert(cur.status === 302 && (cur.headers.get("location") ?? "").endsWith("/v3"), "/current redirects to the current version");
  fake.push(
    msg([toolUse("remember_for_brand", { summary: "Primary CTA is always amber", requested_by: ["Priya"], rationale: "Brand consistency across pages", voice: "Warm, specific, no hype." }), toolUse("publish_version", { html: HTML_V1.replace("Ember", "Ember pricing"), summary: "Pricing page on the Ember brand", changes: [], addresses: ["Priya"] })], "tool_use"),
    msg([text("Pricing page is up, on-brand.")], "end_turn"),
  );
  const t2id = "thread_smoke_pricing";
  await orch.startProject({ threadId: t2id, channelId: "chan", guildId: "guild", brief: "pricing page", createdBy: { id: "u_priya", name: "Priya", role: "pm" } });
  await waitFor("pricing kickoff", async () => (await store.load(t2id))?.turnCount === 1);
  const p2 = (await store.load(t2id))!;
  assert(p2.brandId === "default", "second project bound to the server's default brand");
  const kick = fake.calls[fake.calls.length - 2].messages[0].content;
  const kickText = typeof kick === "string" ? kick : kick.map((b) => (b.type === "text" ? b.text : "")).join("\n");
  assert(kickText.includes("## Brand: Default") && kickText.includes("<!-- header -->") && kickText.includes("<header") && kickText.includes(`/p/${threadId}/current`), "kickoff prompt carries brand chrome and links to existing pages");
  assert(kickText.includes("No carousel component exists"), "brand constraints reach the new page");
  const brand2 = await store.loadBrand("guild", "default");
  assert(brand2!.decisions.length === 1 && brand2!.voice === "Warm, specific, no hype.", "remember_for_brand persisted a rule and the voice");
  assert(surface.log.some((l) => l.includes("On the **Default** brand")), "kickoff message says it's building on the brand");

  // ---- Agent: two servers' turns at once each stay on their own client (bring-your-own-key isolation)
  console.log("\n▶ agent");
  {
    const mkProject = (id: string): Project => ({ id, threadId: id, channelId: "c", brief: id, createdBy: { id: "u", name: "U" }, createdAt: new Date().toISOString(), participants: {}, versions: [], forkHistory: [], constraints: [], decisions: [], questions: [], transcript: [], status: "active", turnCount: 0 });
    const mkCtx = (project: Project): ToolContext => ({ project, store, shots, surface, baseUrl, result: { text: "", toolCalls: 0, iterations: 0, publishedVersionIds: [] }, renderRetries: 0, meter: async () => ({ ok: true, remaining: Infinity }), refund: async () => undefined, urlSuffix: "" });
    const fa = new FakeClient();
    const fb = new FakeClient();
    fa.push(msg([toolUse("say", { text: "A1" })], "tool_use"), msg([text("A done")], "end_turn"));
    fb.push(msg([toolUse("say", { text: "B1" })], "tool_use"), msg([text("B done")], "end_turn"));
    const pa = mkProject("agent_a");
    const pb = mkProject("agent_b");
    await store.save(pa);
    await store.save(pb);
    const [ra, rb] = await Promise.all([
      agent.runTurn({ project: pa, reason: { kind: "kickoff" }, images: [] }, mkCtx(pa), fa as unknown as Anthropic),
      agent.runTurn({ project: pb, reason: { kind: "kickoff" }, images: [] }, mkCtx(pb), fb as unknown as Anthropic),
    ]);
    assert(fa.calls.length === 2 && fb.calls.length === 2 && ra.text === "A done" && rb.text === "B done", "concurrent turns each stay on their own client for every iteration");
  }

  // ---- Product layer: metering, key encryption, URL guard, tokened previews, legal pages
  console.log("\n▶ product layer");
  {
    const metered = new Orchestrator(store, shots, surface, agent, {
      baseUrl,
      debounceMs: 200,
      nudgeMinutes: 0,
      forkTimeoutMinutes: 0,
      product: { metering: true, freeRenders: 3, teamRenders: 40, secret: "test-secret", previewTokens: true },
    });
    const r1 = await metered.consumeRenders("meter-guild", 1);
    const r2 = await metered.consumeRenders("meter-guild", 2);
    const r3 = await metered.consumeRenders("meter-guild", 1);
    assert(r1.ok && r2.ok && r2.remaining === 0 && !r3.ok && /0 renders left/.test(r3.reason ?? ""), "free plan: 3 renders then a clear refusal");
    assert((await metered.consumeRenders(undefined, 5)).ok, "no guild (dry run) is never metered");
    await metered.refundRenders("meter-guild", 1);
    assert((await metered.consumeRenders("meter-guild", 1)).ok, "a refunded render can be spent again");
    const stale = await store.getGuild("meter-stale", { plan: "free", renders: 3 });
    stale.rendersRemaining = 0;
    stale.renewsAt = new Date(Date.now() - 1000).toISOString();
    await store.saveGuild(stale);
    assert(/Renders left:\*\* 3 of 3/.test(await metered.planText("meter-stale")), "/plan applies the monthly reset instead of showing stale numbers");

    // A version that throws is bounced back to the model and its credit returned: one render spent, not two.
    fake.push(
      msg([toolUse("publish_version", { html: HTML_V1.replace("</body>", '<script>throw new Error("boom")</script></body>'), summary: "broken", changes: [], addresses: [] })], "tool_use"),
      msg([toolUse("publish_version", { html: HTML_V1, summary: "fixed", changes: [], addresses: [] })], "tool_use"),
      msg([text("done")], "end_turn"),
    );
    await metered.startProject({ threadId: "thread_bounce", channelId: "chan", guildId: "meter-bounce", brief: "bounce test", createdBy: { id: "u_priya", name: "Priya" } });
    await waitFor("bounce turn", async () => (await store.load("thread_bounce"))?.turnCount === 1);
    const pbounce = (await store.load("thread_bounce"))!;
    const bounced = fake.calls[fake.calls.length - 2].messages[2].content;
    assert(Array.isArray(bounced) && bounced[0].type === "tool_result" && bounced[0].is_error === true && String(bounced[0].content).includes("JavaScript errors"), "a page that throws is bounced back to the model, not posted");
    assert(pbounce.versions.length === 1 && pbounce.versions[0].summary === "fixed", "the fixed retry published as v1");
    assert((await store.getGuild("meter-bounce", { plan: "free", renders: 3 })).rendersRemaining === 2, "the bounced render was refunded: one credit spent, not two");
    assert(/^[A-Za-z0-9_-]{16}$/.test(pbounce.token ?? ""), "hosted project got a 16-char random preview token");

    // With a public base URL, links point at the domain and the screenshot still goes through the local listener.
    const hosted = new Orchestrator(store, shots, surface, agent, { baseUrl: "https://arbiter.example.app", debounceMs: 200, nudgeMinutes: 0, forkTimeoutMinutes: 0 });
    fake.push(msg([toolUse("publish_version", { html: HTML_V1, summary: "hosted v1", changes: [], addresses: [] })], "tool_use"), msg([text("up")], "end_turn"));
    await hosted.startProject({ threadId: "thread_hosted", channelId: "chan", guildId: "guild", brief: "hosted page", createdBy: { id: "u_priya", name: "Priya" } });
    await waitFor("hosted turn", async () => (await store.load("thread_hosted"))?.turnCount === 1);
    const ph = (await store.load("thread_hosted"))!;
    assert(ph.versions.length === 1 && ph.versions[0].previewUrl === "https://arbiter.example.app/p/thread_hosted/v1" && ((await store.readPng("thread_hosted", "v1"))?.length ?? 0) > 10_000, "public base URL: version links publicly and rendered through localhost");
    const { absorbShippedPage, newBrand } = await import("../src/brand.js");
    const bt = absorbShippedPage(newBrand("g", "T"), ph, { ...ph.versions[0], previewUrl: "https://arbiter.example.app/p/thread_hosted/v3?k=abc" }, HTML_V1);
    assert(bt.pages[0].previewUrl === "https://arbiter.example.app/p/thread_hosted/current?k=abc", "site map keeps the access key on /current links");
    const saved = await metered.setByokKey("meter-guild", "sk-ant-api03-" + "x".repeat(40));
    assert(/Saved sk-ant-…xxxx/.test(saved), "byok key saved and masked in the reply");
    const g = await store.getGuild("meter-guild", { plan: "free", renders: 3 });
    assert(g.plan === "byok" && g.byokKeyEnc?.startsWith("v1.") && !g.byokKeyEnc.includes("sk-ant"), "key stored encrypted, plan switched to byok");
    assert((await metered.consumeRenders("meter-guild", 10)).ok, "byok plan is unlimited");
    assert(/doesn't look like/.test(await metered.setByokKey("meter-guild", "hunter2")), "bad key rejected");
    const { encrypt, decrypt } = await import("../src/crypto.js");
    assert(decrypt(encrypt("hello", "s"), "s") === "hello", "encrypt/decrypt roundtrip");
    let tampered = false;
    try {
      decrypt(encrypt("hello", "s"), "wrong");
    } catch {
      tampered = true;
    }
    assert(tampered, "wrong secret fails closed");
    const { assertPublicHttpUrl, isPrivateAddress } = await import("../src/net.js");
    for (const bad of ["http://localhost:3939/", "http://127.0.0.1/", "http://10.0.0.5/x", "http://169.254.169.254/latest/meta-data", "http://[::1]/", "ftp://example.com/", "http://metadata.google.internal/"]) {
      let refused = false;
      try {
        await assertPublicHttpUrl(bad);
      } catch {
        refused = true;
      }
      assert(refused, `url guard refuses ${bad}`);
    }
    assert(isPrivateAddress("192.168.1.1") && isPrivateAddress("fd12::1") && !isPrivateAddress("93.184.216.34") && !isPrivateAddress("2606:2800:220:1:248:1893:25c8:1946"), "private address classifier");
    await assertPublicHttpUrl("http://93.184.216.34/");
    assert(true, "url guard accepts a public address");

    // Tokened previews on a second server instance sharing the store
    const tokened = await listen(createPreviewServer(store, { tokens: true, adminToken: "adm", legalDir: "docs/legal" }), 0);
    const tport = (tokened.address() as AddressInfo).port;
    const tp = (await store.load(threadId))!;
    tp.token = "sekret";
    await store.save(tp);
    assert((await fetch(`http://localhost:${tport}/p/${threadId}/v3`)).status === 403, "hosted preview without key → 403");
    assert((await fetch(`http://localhost:${tport}/p/${threadId}/v3?k=sekret`)).status === 200, "hosted preview with key → 200");
    assert((await fetch(`http://localhost:${tport}/live/${threadId}/state?k=wrong`)).status === 403, "canvas state with wrong key → 403");
    const idxHidden = await fetch(`http://localhost:${tport}/live`);
    assert(idxHidden.status === 404 && (await idxHidden.text()).includes("settles the argument"), "session index hidden when hosted");
    assert((await fetch(`http://localhost:${tport}/live?admin=adm`)).status === 200, "session index unlocked with admin token");
    const cur2 = await fetch(`http://localhost:${tport}/p/${threadId}/current?k=sekret`, { redirect: "manual" });
    assert(cur2.status === 302 && (cur2.headers.get("location") ?? "").endsWith("/v3?k=sekret"), "/current keeps the key on redirect");
    const priv = await fetch(`http://localhost:${tport}/privacy`);
    assert(priv.status === 200 && (await priv.text()).includes("Privacy Policy"), "privacy page served from docs/legal");
    tokened.close();
    tp.token = undefined;
    await store.save(tp);

    // The browser can be redirected or made to embed a private address; every request is checked, not just the first.
    const { publicRequestFilter } = await import("../src/net.js");
    const filt = publicRequestFilter();
    assert((await filt("data:text/html,hi")) && !(await filt("http://127.0.0.1/")) && !(await filt("http://localhost:3939/x")) && (await filt("http://93.184.216.34/a")), "request filter: data ok, private refused, public ok");
    let secretHits = 0;
    const trap = http.createServer((req, res) => {
      if (req.url === "/redirect") {
        res.writeHead(302, { location: `http://127.0.0.1:${(trap.address() as AddressInfo).port}/secret` });
        res.end();
        return;
      }
      if (req.url === "/bounce") {
        res.writeHead(302, { location: "/landing" });
        res.end();
        return;
      }
      if (req.url === "/landing") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end("<title>landing</title><h1>landed</h1>");
        return;
      }
      if (req.url === "/secret") {
        secretHits++;
        res.writeHead(200, { "content-type": "text/html" });
        res.end("<title>secret</title><h1>secret</h1>");
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end('<title>frame</title><iframe src="/secret"></iframe>');
    });
    await new Promise<void>((r) => trap.listen(0, "127.0.0.1", r));
    const trapPort = (trap.address() as AddressInfo).port;
    const onlyNotSecret = async (u: string) => !u.includes("/secret");
    let redirectBlocked = false;
    try {
      await shots.shoot(`http://127.0.0.1:${trapPort}/redirect`, { requestFilter: onlyNotSecret, timeoutMs: 5000, checkMobile: false });
    } catch {
      redirectBlocked = true;
    }
    assert(redirectBlocked && secretHits === 0, "a redirect to a blocked address aborts the shot before the target is fetched");
    const landed = await shots.shoot(`http://127.0.0.1:${trapPort}/bounce`, { requestFilter: onlyNotSecret, checkMobile: false });
    assert(landed.title === "landing", "an allowed redirect is followed hop by hop");
    const framed = await shots.shoot(`http://127.0.0.1:${trapPort}/frame`, { requestFilter: onlyNotSecret, checkMobile: false });
    assert(framed.title === "frame" && secretHits === 0 && framed.warnings.some((w) => w.startsWith("blocked request")), "an iframe to a blocked address is aborted and reported");
    trap.close();
  }

  // ---- Restart survives: fresh store loads state from disk
  const store2 = new Store(dataDir);
  const reloaded = await store2.load(threadId);
  assert(reloaded?.versions.length === 4 && reloaded.status === "shipped", "state survives a restart");

  await shots.close();
  server.close();
  console.log(`\nPASS · data in ${dataDir}`);
  process.exit(0);
}

main().catch((e) => {
  console.error("\nFAIL", e);
  process.exit(1);
});
