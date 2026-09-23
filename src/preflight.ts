import { promises as fs } from "node:fs";
import path from "node:path";
import { configIssues, config } from "./config.js";

export type Level = "fatal" | "warn" | "ok";
export interface Check {
  id: string;
  level: Level;
  title: string;
  fix?: string;
}

type Cfg = typeof config;
type Env = Record<string, string | undefined>;

const EFFORTS = ["low", "medium", "high", "xhigh", "max"];

/**
 * Everything that can stop Arbiter working, checked up front. Fatal problems keep the bot offline but the
 * web server up, so the deployment stays healthy and the domain shows what to fix instead of crash-looping.
 * Never includes secret values.
 */
export function preflight(cfg: Cfg, env: Env = process.env): Check[] {
  const out: Check[] = [];
  const onRailway = Boolean(env.RAILWAY_PROJECT_ID || env.RAILWAY_ENVIRONMENT_NAME || env.RAILWAY_SERVICE_ID);
  const add = (id: string, level: Level, title: string, fix?: string) => out.push({ id, level, title, fix });

  // Discord
  if (!cfg.discord.token) add("discord-token", "fatal", "DISCORD_TOKEN is not set", "Discord Developer Portal → your app → Bot → Reset Token, then set DISCORD_TOKEN.");
  else if (cfg.discord.token.split(".").length !== 3) add("discord-token", "fatal", "DISCORD_TOKEN doesn't look like a bot token", "Bot tokens have three parts separated by dots. Copy it again from Developer Portal → Bot → Reset Token (not the client secret or public key).");
  else add("discord-token", "ok", "Discord bot token is set");
  if (!cfg.discord.clientId) add("discord-client", "fatal", "DISCORD_CLIENT_ID is not set", "Developer Portal → General Information → Application ID.");
  else if (!/^\d{15,22}$/.test(cfg.discord.clientId)) add("discord-client", "fatal", "DISCORD_CLIENT_ID should be a number", "Use the Application ID from General Information, not the public key or client secret.");
  else add("discord-client", "ok", "Discord application id is set");
  if (onRailway && cfg.discord.guildId) add("discord-guild", "warn", "DISCORD_GUILD_ID is set", "In production, remove it so slash commands register on every server, not only that one.");

  // Model
  if (!env.ANTHROPIC_API_KEY && !env.ANTHROPIC_AUTH_TOKEN) add("anthropic", "fatal", "ANTHROPIC_API_KEY is not set", "Create a key at console.anthropic.com → API Keys and set ANTHROPIC_API_KEY.");
  else add("anthropic", "ok", "Anthropic API key is set");
  if (!EFFORTS.includes(cfg.model.effort)) add("effort", "warn", `ARBITER_EFFORT "${cfg.model.effort}" isn't one of ${EFFORTS.join(", ")}`, "Set it to medium (or remove it).");

  // Hosting
  if (onRailway && !env.PUBLIC_BASE_URL && !env.RAILWAY_PUBLIC_DOMAIN) add("public-url", "warn", "No public URL", "Railway → service → Networking → Generate Domain. Preview links will say localhost until then.");
  else if (cfg.server.publicBaseUrl && !/^https:\/\//.test(cfg.server.publicBaseUrl) && onRailway) add("public-url", "warn", "PUBLIC_BASE_URL isn't https", "Use the https:// domain Railway gives you.");
  else if (cfg.server.publicBaseUrl) add("public-url", "ok", `Public URL: ${cfg.server.publicBaseUrl}`);
  if (onRailway && !env.RAILWAY_VOLUME_MOUNT_PATH) add("volume", "warn", "No Railway volume attached", "Sessions, brands and billing state are wiped on every deploy. Service → Settings → Volumes → add one mounted at /data.");
  else if (onRailway && env.RAILWAY_VOLUME_MOUNT_PATH && path.resolve(cfg.dataDir) !== path.resolve(env.RAILWAY_VOLUME_MOUNT_PATH)) add("volume", "warn", `DATA_DIR (${cfg.dataDir}) isn't the volume (${env.RAILWAY_VOLUME_MOUNT_PATH})`, "Remove DATA_DIR, or set it to the volume's mount path.");
  else if (onRailway) add("volume", "ok", `Data on the volume at ${env.RAILWAY_VOLUME_MOUNT_PATH}`);

  // Product
  if (cfg.product.metering && !cfg.product.secret) add("secret", "warn", "METERING is on but ARBITER_SECRET is not set", "Set ARBITER_SECRET (openssl rand -hex 32). Without it, /setup keys and Stripe billing stay off.");
  const stripeVars = { STRIPE_SECRET_KEY: cfg.stripe.secretKey, STRIPE_WEBHOOK_SECRET: cfg.stripe.webhookSecret, STRIPE_PRICE_TEAM: cfg.stripe.priceTeam, STRIPE_PRICE_PACK: cfg.stripe.pricePack };
  const stripeMissing = Object.entries(stripeVars).filter(([, v]) => !v).map(([k]) => k);
  if (stripeMissing.length > 0 && stripeMissing.length < 4) add("stripe", "warn", `Stripe is half set up: missing ${stripeMissing.join(", ")}`, "Billing stays off until all four are set (see docs/GO-LIVE.md).");
  else if (stripeMissing.length === 0) {
    if (!/^(sk|rk)_(test|live)_/.test(cfg.stripe.secretKey)) add("stripe", "warn", "STRIPE_SECRET_KEY doesn't look like a secret key", "It starts with sk_test_, sk_live_ or rk_live_ (not the publishable pk_ key).");
    else if (!/^whsec_/.test(cfg.stripe.webhookSecret)) add("stripe", "warn", "STRIPE_WEBHOOK_SECRET doesn't start with whsec_", "Copy the signing secret from the webhook endpoint, not an API key.");
    else if (!/^price_/.test(cfg.stripe.priceTeam) || !/^price_/.test(cfg.stripe.pricePack)) add("stripe", "warn", "Stripe price ids should start with price_", "Open each product in Stripe and copy the price id (not the prod_ product id).");
    else add("stripe", "ok", `Stripe billing configured (${cfg.stripe.secretKey.includes("_live_") ? "live" : "test"} mode)`);
  }

  for (const i of configIssues) add(`env-${i.key}`, "warn", `${i.key} ${i.message}`);
  return out;
}

/** Can we write the data directory? Returns a check. */
export async function checkDataDir(dir: string, timeoutMs = 5_000): Promise<Check> {
  try {
    const probe = path.join(dir, `.write-test-${process.pid}`);
    const work = (async () => {
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(probe, "ok");
      await fs.rm(probe, { force: true });
    })();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`no response from the disk after ${timeoutMs / 1000}s`)), timeoutMs);
      timer.unref();
    });
    try {
      await Promise.race([work, timeout]);
    } finally {
      clearTimeout(timer);
    }
    return { id: "data-dir", level: "ok", title: `Data directory ${dir} is writable` };
  } catch (e) {
    return { id: "data-dir", level: "fatal", title: `Can't write to the data directory ${dir}`, fix: `Check the volume mount and DATA_DIR. (${(e as Error).message})` };
  }
}

export function hasFatal(checks: Check[]): boolean {
  return checks.some((c) => c.level === "fatal");
}
