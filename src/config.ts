import "dotenv/config";

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number, got "${raw}"`);
  return n;
}

function str(name: string, fallback = ""): string {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
}

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export const config = {
  discord: {
    token: str("DISCORD_TOKEN"),
    clientId: str("DISCORD_CLIENT_ID"),
    guildId: str("DISCORD_GUILD_ID"),
  },
  model: {
    id: str("ARBITER_MODEL", "claude-opus-5"),
    effort: str("ARBITER_EFFORT", "medium") as Effort,
    fastMode: str("ARBITER_FAST_MODE", "0") === "1",
    maxIterations: num("ARBITER_MAX_ITERATIONS", 8),
  },
  server: {
    port: num("PORT", 3939),
    publicBaseUrl: str("PUBLIC_BASE_URL").replace(/\/$/, ""),
    chromiumPath: str("CHROMIUM_PATH") || undefined,
  },
  voice: {
    stt: str("VOICE_STT", "auto"), // auto | elevenlabs | openai | off
    tts: str("VOICE_TTS", "1") === "1",
    elevenLabsKey: str("ELEVENLABS_API_KEY"),
    elevenLabsVoiceId: str("ELEVENLABS_VOICE_ID", "21m00Tcm4TlvTq8ikWAM"),
    openaiKey: str("OPENAI_API_KEY"),
    mode: str("VOICE_MODE", "listen") as "listen" | "address",
    minSeconds: num("VOICE_MIN_SECONDS", 1.0),
    minRms: num("VOICE_MIN_RMS", 400),
    debounceMs: num("VOICE_DEBOUNCE_MS", 12_000),
    showIgnored: str("VOICE_SHOW_IGNORED", "1") === "1",
    gateModel: str("VOICE_GATE_MODEL", "claude-haiku-4-5"),
  },
  dataDir: str("DATA_DIR", "./data"),
  debounceMs: num("DEBOUNCE_MS", 6000),
  nudgeMinutes: num("NUDGE_MINUTES", 3),
  forkTimeoutMinutes: num("FORK_TIMEOUT_MINUTES", 5),
};

export function baseUrl(): string {
  return config.server.publicBaseUrl || `http://localhost:${config.server.port}`;
}

export function requireDiscordConfig(): void {
  const missing = (["token", "clientId"] as const).filter((k) => !config.discord[k]);
  if (missing.length) {
    throw new Error(
      `Missing Discord config: ${missing.map((k) => "DISCORD_" + k.replace(/[A-Z]/g, (c) => "_" + c).toUpperCase()).join(", ")}. Copy .env.example to .env and fill it in.`,
    );
  }
}
