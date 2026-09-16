import Anthropic from "@anthropic-ai/sdk";
import { config, baseUrl, requireDiscordConfig } from "./config.js";
import { Store } from "./store.js";
import { createPreviewServer, listen } from "./render/server.js";
import { Screenshotter } from "./render/screenshot.js";
import { Agent } from "./agent/run.js";
import { Orchestrator } from "./orchestrator.js";
import { createDiscordClient, attachHandlers } from "./discord/bot.js";
import { DiscordSurface } from "./discord/surface.js";
import { explainDiscordError } from "./discord/errors.js";
import { VoiceManager } from "./voice/manager.js";
import { generateDependencyReport } from "@discordjs/voice";
import { pickSTT } from "./voice/stt.js";
import { ElevenLabsTTS } from "./voice/tts.js";
import { RelevanceGate } from "./voice/gate.js";
import { log, errMsg } from "./log.js";

async function main(): Promise<void> {
  requireDiscordConfig();

  const store = new Store(config.dataDir);
  await store.init();

  const server = await listen(
    createPreviewServer(store, { tokens: config.product.previewTokens, adminToken: config.product.adminToken || undefined, legalDir: "docs/legal" }),
    config.server.port,
  );
  const shots = new Screenshotter(config.server.chromiumPath, config.product.maxConcurrentRenders);

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
    voiceDebounceMs: config.voice.debounceMs,
    product: {
      metering: config.product.metering,
      freeRenders: config.product.freeRenders,
      teamRenders: config.product.teamRenders,
      upgradeUrl: config.product.upgradeUrl || undefined,
      secret: config.product.secret || undefined,
      previewTokens: config.product.previewTokens,
    },
    nudgeMinutes: config.nudgeMinutes,
    forkTimeoutMinutes: config.forkTimeoutMinutes,
  });
  orch.setDefaultClient(anthropic);
  await orch.resume();

  const stt = pickSTT({ preference: config.voice.stt, elevenLabsKey: config.voice.elevenLabsKey || undefined, openaiKey: config.voice.openaiKey || undefined });
  const tts = config.voice.tts && config.voice.elevenLabsKey ? new ElevenLabsTTS(config.voice.elevenLabsKey, config.voice.elevenLabsVoiceId) : undefined;
  const gate = stt ? new RelevanceGate(anthropic, config.voice.gateModel) : undefined;
  const voice = new VoiceManager(client, orch, surface, stt, tts, gate, {
    mode: config.voice.mode === "address" ? "address" : "listen",
    minSeconds: config.voice.minSeconds,
    minRms: config.voice.minRms,
    showIgnored: config.voice.showIgnored,
  });
  orch.attachVoice(voice);

  attachHandlers(client, orch, voice);
  try {
    await client.login(config.discord.token);
  } catch (e) {
    throw new Error(explainDiscordError(e));
  }
  log.info(`arbiter up · model=${config.model.id} effort=${config.model.effort} fast=${config.model.fastMode} · previews at ${baseUrl()}`);
  log.info(`product · metering=${config.product.metering} previewTokens=${config.product.previewTokens} byok=${config.product.secret ? "enabled" : "off (set ARBITER_SECRET)"} maxRenders=${config.product.maxConcurrentRenders}`);
  log.info(`voice · stt=${stt?.name ?? "none (set ELEVENLABS_API_KEY or OPENAI_API_KEY)"} · tts=${tts ? "elevenlabs" : "off"} · mode=${config.voice.mode} · gate=${gate ? config.voice.gateModel : "off"} · batch=${config.voice.debounceMs}ms`);
  if (stt) log.info("voice dependency report:\n" + generateDependencyReport());

  const shutdown = async (sig: string) => {
    log.info(`${sig} — shutting down`);
    await voice.destroyAll().catch(() => undefined);
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
