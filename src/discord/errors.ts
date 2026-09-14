import { DiscordAPIError } from "discord.js";
import { errMsg } from "../log.js";

const PERMS = "Send Messages, Create Public Threads, Send Messages in Threads, Embed Links, Attach Files, Read Message History, Add Reactions, Use Slash Commands";

/** Turn the common first-run Discord failures into instructions. */
export function explainDiscordError(e: unknown): string {
  const code = (e as { code?: unknown })?.code;
  if (code === "DisallowedIntents") {
    return "Discord refused the login because the Message Content intent is not enabled. Developer Portal → your app → Bot → Privileged Gateway Intents → turn on MESSAGE CONTENT INTENT → Save, then restart.";
  }
  if (code === "TokenInvalid") {
    return "DISCORD_TOKEN is not a valid bot token. Developer Portal → Bot → Reset Token, paste the new value into .env, restart.";
  }
  if (e instanceof DiscordAPIError) {
    switch (e.code) {
      case 50013:
        return `The bot is missing permissions in this channel. Re-invite it (OAuth2 → URL Generator: scopes bot + applications.commands) with: ${PERMS}. Also check the channel's own permission overrides.`;
      case 50001:
        return "The bot cannot see this channel (Missing Access). Give it View Channel here, or use a channel it can see.";
      case 10004:
        return "Unknown Guild: DISCORD_GUILD_ID in .env is not a server this bot is in. Right-click the server → Copy Server ID.";
      case 10002:
        return "Unknown Application: DISCORD_CLIENT_ID in .env is wrong. Developer Portal → General Information → Application ID.";
      case 50035:
        return `Discord rejected the payload (${e.message}). This is a bug in Arbiter's message shape; send the terminal output to the maintainer.`;
      default:
        if (e.status === 401) return "Discord returned 401: DISCORD_TOKEN is wrong or was reset.";
        if (e.status === 403) return `Discord returned 403 (${e.message}). Usually the bot is not in the server, or lacks: ${PERMS}.`;
        return `Discord API error ${e.status} (${e.code}): ${e.message}`;
    }
  }
  return errMsg(e);
}
