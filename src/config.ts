import "dotenv/config";

/** Problems found while reading the environment; surfaced on the setup page instead of crashing. */
export const configIssues: { key: string; message: string }[] = [];

/**
 * Read an env var tolerant of copy-paste: strips a trailing "  # comment" (hosting dashboards don't) and
 * wrapping quotes. Records what it cleaned so the setup page can say so.
 */
function raw(name: string): string | undefined {
  const v = process.env[name];
  if (v === undefined) return undefined;
  let out = v.trim();
  const commented = /\s+#.*$/.exec(out);
  if (commented) {
    out = out.slice(0, commented.index).trim();
    configIssues.push({ key: name, message: `had a trailing comment ("${commented[0].trim().slice(0, 40)}"). It was ignored; remove it from the variable.` });
  }
  if (/^(["']).*\1$/.test(out)) out = out.slice(1, -1);
  return out;
}

function num(name: string, fallback: number): number {
  const v = raw(name);
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) {
    configIssues.push({ key: name, message: `must be a number, got "${v.slice(0, 40)}". Using the default (${fallback}).` });
    return fallback;
  }
  return n;
}

function str(name: string, fallback = ""): string {
  const v = raw(name);
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
    publicBaseUrl: (str("PUBLIC_BASE_URL") || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : "")).replace(/\/$/, ""),
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
  /** commercial + hosted-mode settings */
  product: {
    metering: str("METERING", "0") === "1",
    freeRenders: num("FREE_RENDERS_PER_MONTH", 3),
    teamRenders: num("TEAM_RENDERS_PER_MONTH", 40),
    upgradeUrl: str("UPGRADE_URL"), // e.g. https://arbiter.app/upgrade?guild={guild}
    secret: str("ARBITER_SECRET"), // encrypts bring-your-own keys at rest
    previewTokens: str("PREVIEW_TOKENS", str("PUBLIC_BASE_URL") || process.env.RAILWAY_PUBLIC_DOMAIN ? "1" : "0") === "1",
    adminToken: str("ADMIN_TOKEN"), // unlocks the /live session index when hosted
    maxConcurrentRenders: num("MAX_CONCURRENT_RENDERS", 3),
    packRenders: num("PACK_RENDERS", 20),
    retentionDays: num("RETENTION_DAYS", 30),
    contactEmail: str("CONTACT_EMAIL"),
    teamPriceLabel: str("TEAM_PRICE_LABEL", "$12 / month"),
    packPriceLabel: str("PACK_PRICE_LABEL", "$5"),
  },
  stripe: {
    secretKey: str("STRIPE_SECRET_KEY"),
    webhookSecret: str("STRIPE_WEBHOOK_SECRET"),
    priceTeam: str("STRIPE_PRICE_TEAM"),
    pricePack: str("STRIPE_PRICE_PACK"),
    automaticTax: str("STRIPE_AUTOMATIC_TAX", "0") === "1",
  },
  dataDir: str("DATA_DIR", process.env.RAILWAY_VOLUME_MOUNT_PATH || "./data"),
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
