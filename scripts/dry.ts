/**
 * Dry run: the real agent with a console "thread" instead of Discord.
 *   npm run dry -- "landing page for a coffee subscription"
 * Type feedback as yourself (you're the PM), or as other people:  sam(designer): more whitespace
 * A conflict needs two different people, e.g.  sam(designer): more whitespace  then  priya(pm): denser
 * Commands: /vote <name> a|b · /resolve · /approve <name> · /constraint <name>: text · /handoff · /status · /quit
 */
import Anthropic from "@anthropic-ai/sdk";
import readline from "node:readline";
import type { AddressInfo } from "node:net";
import { config } from "../src/config.js";
import { Store } from "../src/store.js";
import { createPreviewServer, listenOrFallback } from "../src/render/server.js";
import { Screenshotter } from "../src/render/screenshot.js";
import { Agent } from "../src/agent/run.js";
import { Orchestrator } from "../src/orchestrator.js";
import { ConsoleSurface } from "./console-surface.js";
import type { Role } from "../src/types.js";

async function main(): Promise<void> {
  const brief = process.argv.slice(2).join(" ").trim();
  if (!brief) {
    console.error('usage: npm run dry -- "brief for the page"');
    process.exit(1);
  }
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    console.warn("\x1b[33m⚠ ANTHROPIC_API_KEY is not set. Copy .env.example to .env (same folder as package.json) and fill it in.\x1b[0m");
  }
  const store = new Store(config.dataDir);
  await store.init();
  const server = await listenOrFallback(createPreviewServer(store), config.server.port || 0);
  const port = (server.address() as AddressInfo).port;
  process.env.PORT = String(port);
  const shots = new Screenshotter(config.server.chromiumPath);
  const agent = new Agent(new Anthropic(), {
    model: config.model.id,
    effort: config.model.effort,
    fastMode: config.model.fastMode,
    maxIterations: config.model.maxIterations,
    fallbacks: process.env.ARBITER_FALLBACKS !== "0",
  });
  const surface = new ConsoleSurface();
  const orch = new Orchestrator(store, shots, surface, agent, { baseUrl: `http://localhost:${port}`, debounceMs: 8000, nudgeMinutes: 2, forkTimeoutMinutes: 3 });

  const threadId = `dry_${Date.now().toString(36)}`;
  const referenceUrl = /(https?:\/\/\S+)/.exec(brief)?.[1];
  console.log(`model=${config.model.id} effort=${config.model.effort} fast=${config.model.fastMode} · state in ${config.dataDir}/projects/${threadId}`);
  const url = `http://localhost:${port}/live/${threadId}`;
  const bar = "═".repeat(Math.max(40, url.length + 20));
  console.log(`\n╔${bar}╗\n║  📺 Live canvas:  ${url}${" ".repeat(Math.max(0, bar.length - url.length - 19))}║\n║  All sessions:    http://localhost:${port}/live${" ".repeat(Math.max(0, bar.length - `http://localhost:${port}/live`.length - 19))}║\n╚${bar}╝\n`);
  console.log("Kickoff is running. The first render takes ~30–90s; you'll see 📐 v1 when it lands. Type feedback any time, e.g.  sam(designer): more whitespace\n");
  console.log("You are the PM. Type feedback as yourself, or as others:  sam(designer): more whitespace   ·   /help for commands\n");
  const existing = await store.listBrands("console");
  if (existing.length) console.log(`🧠 brand memory found: ${existing.map((b) => `${b.name} (${b.pages.length} pages)`).join(", ")} — this page will start from the default brand\n`);
  await orch.startProject({ threadId, channelId: "console", guildId: "console", brief, referenceUrl, createdBy: { id: "you", name: "You", role: "pm" } });

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (): void => rl.question("> ", (line) => void handle(line.trim()).then(ask));
  const people = new Map<string, { id: string; role?: Role }>();
  const who = (name: string, role?: string) => {
    const key = name.toLowerCase();
    if (key === "you" || key === "me") return { userId: "you", name: "You", role: "pm" as Role }; // the session creator
    if (!people.has(key)) people.set(key, { id: `u_${key}`, role: role as Role | undefined });
    const p = people.get(key)!;
    if (role) p.role = role as Role;
    return { userId: p.id, name, role: p.role };
  };

  async function handle(line: string): Promise<void> {
    if (!line) return;
    if (line === "/quit") {
      await shots.close();
      server.close();
      process.exit(0);
    }
    if (line === "/help") {
      console.log([
        "  <text>                    feedback from You (pm)",
        "  sam(designer): <text>     feedback from someone else (roles: designer, pm, eng, stakeholder)",
        "  make it feel like https://linear.app     → the agent studies the site and adopts its palette/type",
        "  /vote <name> a|b · /resolve · /approve <name> · /constraint <name>: <text> · /handoff · /status · /brand · /quit",
      ].join("\n"));
      return;
    }
    if (line === "/status") return console.log(await orch.statusText(threadId));
    if (line === "/brand") return console.log(await orch.brandStatus("console"));
    if (line === "/handoff") return void (await orch.handoff(threadId));
    if (line === "/resolve") {
      const p = await store.load(threadId);
      if (p?.fork && !p.fork.resolved) console.log(await orch.resolveFork(threadId, p.fork.id, "console"));
      else console.log("No vote is open right now.");
      return;
    }
    let m = /^\/vote\s+(\w+)\s+([ab])$/i.exec(line);
    if (m) {
      const p = await store.load(threadId);
      const w = who(m[1]);
      if (p?.fork && !p.fork.resolved) console.log(await orch.vote(threadId, p.fork.id, w.userId, w.name, m[2].toLowerCase() as "a" | "b"));
      else console.log("No vote is open right now. A vote opens when two people ask for incompatible things.");
      return;
    }
    m = /^\/approve\s+(\w+)$/i.exec(line);
    if (m) {
      const p = await store.load(threadId);
      const w = who(m[1]);
      if (p?.currentVersionId) console.log(await orch.approve(threadId, p.currentVersionId, w.userId, w.name));
      else console.log("Nothing to approve yet.");
      return;
    }
    m = /^\/constraint\s+(\w+):\s*(.+)$/i.exec(line);
    if (m) {
      const w = who(m[1]);
      return orch.addConstraint(threadId, m[2], w.userId, w.name);
    }
    m = /^(\w+)(?:\((\w+)\))?:\s*(.+)$/.exec(line);
    if (m && !/^https?$/i.test(m[1])) {
      const w = who(m[1], m[2]);
      await orch.addHumanMessage(threadId, { ...w, text: m[3] });
      console.log(`   ⏳ queued from ${w.name}; the agent acts in 8s unless more messages land (type a second person's line now to stage a conflict)`);
      return;
    }
    if (line.startsWith("/")) {
      console.log("Unknown command. /help lists them.");
      return;
    }
    // Anything else is you, the PM, talking.
    await orch.addHumanMessage(threadId, { userId: "you", name: "You", role: "pm", text: line });
    console.log("   ⏳ queued from You; the agent acts in 8s unless more messages land");
  }
  ask();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
