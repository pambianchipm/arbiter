/**
 * End-to-end smoke test with a scripted fake model: exercises the orchestrator,
 * tool execution, preview server, Playwright screenshots, votes, approval, and
 * handoff — everything except the live Claude call. Run: npm run smoke
 */
import type Anthropic from "@anthropic-ai/sdk";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import type { AddressInfo } from "node:net";
import { Store } from "../src/store.js";
import { createPreviewServer, listen } from "../src/render/server.js";
import { Screenshotter } from "../src/render/screenshot.js";
import { Agent } from "../src/agent/run.js";
import { Orchestrator } from "../src/orchestrator.js";
import { ConsoleSurface } from "./console-surface.js";
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
  assert(surface.log.some((l) => l.includes("Handoff for") && l.includes("BUILD.md") && l.includes("Next.js + Tailwind")), "agent's post_handoff tool posted the package with the stack");
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
  assert(last.includes("handoff-thread_smoke.md") && last.includes("BUILD.md") && last.includes("v3.html") && last.includes("v3.png"), "handoff attached spec + BUILD.md + html + png");
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
