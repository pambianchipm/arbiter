import { REST, Routes } from "discord.js";
import { commands } from "./commands.js";
import { config, requireDiscordConfig } from "../config.js";
import { log } from "../log.js";
import { explainDiscordError } from "./errors.js";

export async function registerCommands(knownGuilds: { id: string; name: string }[] = []): Promise<void> {
  requireDiscordConfig();
  const rest = new REST({ version: "10" }).setToken(config.discord.token);
  const gid = config.discord.guildId;
  if (gid && knownGuilds.length && !knownGuilds.some((g) => g.id === gid)) {
    throw new Error(
      `DISCORD_GUILD_ID=${gid} is not a server this bot is in. It is in: ${knownGuilds.map((g) => `${g.name} (${g.id})`).join(", ")}. Put one of those ids in .env, or invite the bot to the server you meant.`,
    );
  }
  try {
    if (config.discord.guildId) {
      await rest.put(Routes.applicationGuildCommands(config.discord.clientId, config.discord.guildId), { body: commands });
      log.info(`registered ${commands.length} guild commands for ${config.discord.guildId}`);
    } else {
      await rest.put(Routes.applicationCommands(config.discord.clientId), { body: commands });
      log.info(`registered ${commands.length} global commands (can take up to an hour to appear)`);
    }
  } catch (e) {
    const code = (e as { code?: unknown })?.code;
    if (code === 50001 || code === 10004) {
      throw new Error(
        `Slash-command registration was refused for guild ${gid || "(global)"} (Discord: Missing Access). The bot is in that server but was invited WITHOUT the applications.commands scope. Fix: Developer Portal → OAuth2 → URL Generator → tick BOTH "bot" and "applications.commands" → open the URL → pick the server. No need to kick the bot first. Until then, "@Arbiter <brief>" still works; only the slash commands are missing.`,
      );
    }
    throw new Error(`Slash-command registration failed: ${explainDiscordError(e)}`);
  }
}

// `npm run register` — standalone
if (process.argv[1] && /register\.(ts|js)$/.test(process.argv[1])) {
  registerCommands().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
