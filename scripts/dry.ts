/**
 * Dry run: the real agent with a console "thread" instead of Discord.
 *   npm run dry -- "landing page for a coffee subscription"
 * Then type lines as people:  sam(designer): more whitespace
 * Commands: /vote <name> a|b · /resolve · /approve <name> · /constraint <name>: text · /handoff · /status · /quit
 */
import Anthropic from "@anthropic-ai/sdk";
import readline from "node:readline";
import type { AddressInfo } from "node:net";
import { config } from "../src/config.js";
import { Store } from "../src/store.js";
import { createPreviewServer, listen } from "../src/render/server.js";
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
  const store = new Store(config.dataDir);
  await store.init();
  const server = await listen(createPreviewServer(store), config.server.port || 0);
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
  const orch = new Orchestrator(store, shots, surface, agent, { baseUrl: `http://localhost:${port}`, debounceMs: 3000, nudgeMinutes: 1, forkTimeoutMinutes: 2 });

  const threadId = `dry_${Date.now().toString(36)}`;
  console.log(`model=${config.model.id} effort=${config.model.effort} fast=${config.model.fastMode} · state in ${config.dataDir}/projects/${threadId}`);
  console.log(`\x1b[1m📺 Live canvas: http://localhost:${port}/live/${threadId}\x1b[0m   (index of all sessions: http://localhost:${port}/live)`);
  console.log("Kickoff is running. The first render takes ~30–90s; you'll see 📐 v1 when it lands. Type feedback any time, e.g.  sam(designer): more whitespace\n");
  await orch.startProject({ threadId, channelId: "console", brief, createdBy: { id: "you", name: "You", role: "pm" } });

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (): void => rl.question("> ", (line) => void handle(line.trim()).then(ask));
  const people = new Map<string, { id: string; role?: Role }>();
  const who = (name: string, role?: string) => {
    const key = name.toLowerCase();
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
    if (line === "/status") return console.log(await orch.statusText(threadId));
    if (line === "/handoff") return void (await orch.handoff(threadId));
    if (line === "/resolve") {
      const p = await store.load(threadId);
      if (p?.fork) console.log(await orch.resolveFork(threadId, p.fork.id, "console"));
      return;
    }
    let m = /^\/vote\s+(\w+)\s+([ab])$/i.exec(line);
    if (m) {
      const p = await store.load(threadId);
      const w = who(m[1]);
      if (p?.fork) console.log(await orch.vote(threadId, p.fork.id, w.userId, w.name, m[2].toLowerCase() as "a" | "b"));
      return;
    }
    m = /^\/approve\s+(\w+)$/i.exec(line);
    if (m) {
      const p = await store.load(threadId);
      const w = who(m[1]);
      if (p?.currentVersionId) console.log(await orch.approve(threadId, p.currentVersionId, w.userId, w.name));
      return;
    }
    m = /^\/constraint\s+(\w+):\s*(.+)$/i.exec(line);
    if (m) {
      const w = who(m[1]);
      return orch.addConstraint(threadId, m[2], w.userId, w.name);
    }
    m = /^(\w+)(?:\((\w+)\))?:\s*(.+)$/.exec(line);
    if (m) {
      const w = who(m[1], m[2]);
      return orch.addHumanMessage(threadId, { ...w, text: m[3] });
    }
    console.log("format:  name(role): message   e.g.  sam(designer): more whitespace");
  }
  ask();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
