import { REST, Routes } from "discord.js";
import { commands } from "./commands.js";
import { config, requireDiscordConfig } from "../config.js";
import { log } from "../log.js";
import { explainDiscordError } from "./errors.js";

export async function registerCommands(): Promise<void> {
  requireDiscordConfig();
  const rest = new REST({ version: "10" }).setToken(config.discord.token);
  try {
    if (config.discord.guildId) {
      await rest.put(Routes.applicationGuildCommands(config.discord.clientId, config.discord.guildId), { body: commands });
      log.info(`registered ${commands.length} guild commands for ${config.discord.guildId}`);
    } else {
      await rest.put(Routes.applicationCommands(config.discord.clientId), { body: commands });
      log.info(`registered ${commands.length} global commands (can take up to an hour to appear)`);
    }
  } catch (e) {
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
