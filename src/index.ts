import Anthropic from "@anthropic-ai/sdk";
import { config, baseUrl, requireDiscordConfig } from "./config.js";
import { Store } from "./store.js";
import { createPreviewServer, listen } from "./render/server.js";
import { Screenshotter } from "./render/screenshot.js";
import { Agent } from "./agent/run.js";
import { Orchestrator } from "./orchestrator.js";
import { createDiscordClient, attachHandlers } from "./discord/bot.js";
import { DiscordSurface } from "./discord/surface.js";
import { log, errMsg } from "./log.js";

async function main(): Promise<void> {
  requireDiscordConfig();

  const store = new Store(config.dataDir);
  await store.init();

  const server = await listen(createPreviewServer(store), config.server.port);
  const shots = new Screenshotter(config.server.chromiumPath);

  const anthropic = new Anthropic();
  const agent = new Agent(anthropic, {
    model: config.model.id,
    effort: config.model.effort,
    fastMode: config.model.fastMode,
    maxIterations: config.model.maxIterations,
    fallbacks: process.env.ARBITER_FALLBACKS !== "0",
  });

  const client = createDiscordClient();
  const surface = new DiscordSurface(client);
  const orch = new Orchestrator(store, shots, surface, agent, {
    baseUrl: baseUrl(),
    debounceMs: config.debounceMs,
    nudgeMinutes: config.nudgeMinutes,
    forkTimeoutMinutes: config.forkTimeoutMinutes,
  });
  await orch.resume();

  attachHandlers(client, orch);
  await client.login(config.discord.token);
  log.info(`arbiter up · model=${config.model.id} effort=${config.model.effort} fast=${config.model.fastMode} · previews at ${baseUrl()}`);

  const shutdown = async (sig: string) => {
    log.info(`${sig} — shutting down`);
    client.destroy();
    await shots.close();
    server.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((e) => {
  log.error("fatal", errMsg(e));
  process.exit(1);
});
