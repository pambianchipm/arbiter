import { SlashCommandBuilder } from "discord.js";
import { ROLES } from "../types.js";

export const commands = [
  new SlashCommandBuilder()
    .setName("design")
    .setDescription("Start a design session in a new thread: Arbiter builds v1 and iterates with the team")
    .addStringOption((o) => o.setName("brief").setDescription("What are we building? e.g. 'landing page for a coffee subscription'").setRequired(true).setMaxLength(600))
    .addAttachmentOption((o) => o.setName("sketch").setDescription("Whiteboard photo or napkin sketch — used as the layout spec"))
    .addStringOption((o) => o.setName("reference").setDescription("A site to take the feel from, e.g. https://linear.app"))
    .addStringOption((o) => o.setName("brand").setDescription("Which brand memory to design on (default: this server's last-used brand)").setAutocomplete(true)),
  new SlashCommandBuilder()
    .setName("role")
    .setDescription("Tell Arbiter your role so it can route questions and break ties")
    .addStringOption((o) =>
      o
        .setName("role")
        .setDescription("Your role on this team")
        .setRequired(true)
        .addChoices(...ROLES.map((r) => ({ name: r, value: r }))),
    ),
  new SlashCommandBuilder()
    .setName("constraint")
    .setDescription("Record a hard constraint (e.g. 'no carousel component') that every version must respect")
    .addStringOption((o) => o.setName("text").setDescription("The constraint").setRequired(true).setMaxLength(400)),
  new SlashCommandBuilder()
    .setName("handoff")
    .setDescription("Post the handoff: decision log, constraints, final source, and BUILD.md for a coding agent")
    .addStringOption((o) => o.setName("stack").setDescription("Target stack for BUILD.md, e.g. 'Next.js + Tailwind + shadcn'").setMaxLength(120)),
  new SlashCommandBuilder().setName("status").setDescription("Where this design session stands"),
  new SlashCommandBuilder().setName("help").setDescription("How to use Arbiter: start a session, iterate, vote, ship"),
  new SlashCommandBuilder().setName("plan").setDescription("This server's plan, renders left, and how to add more"),
  new SlashCommandBuilder()
    .setName("setup")
    .setDescription("Bring your own Anthropic API key for this server (stored encrypted, never shown)")
    .addSubcommand((sc) => sc.setName("key").setDescription("Save your Anthropic API key").addStringOption((o) => o.setName("key").setDescription("sk-ant-…").setRequired(true)))
    .addSubcommand((sc) => sc.setName("remove").setDescription("Delete the saved key")),
  new SlashCommandBuilder().setName("forget").setDescription("Delete this design thread's data from Arbiter (creator or server managers)"),
  new SlashCommandBuilder()
    .setName("brand")
    .setDescription("This server's brand memory: tokens, shared header/footer, rules, and the site map")
    .addSubcommand((sc) => sc.setName("show").setDescription("Show the current brand and its pages").addStringOption((o) => o.setName("name").setDescription("A specific brand").setAutocomplete(true)))
    .addSubcommand((sc) => sc.setName("new").setDescription("Start a new, empty brand and make it the default").addStringOption((o) => o.setName("name").setDescription("Brand name").setRequired(true).setMaxLength(60)))
    .addSubcommand((sc) => sc.setName("use").setDescription("Switch the default brand for new /design sessions").addStringOption((o) => o.setName("name").setDescription("Brand name").setRequired(true).setAutocomplete(true))),
  new SlashCommandBuilder()
    .setName("voice")
    .setDescription("Let Arbiter listen in your voice channel and iterate on what the team says")
    .addSubcommand((sc) =>
      sc
        .setName("join")
        .setDescription("Join the voice channel you're in and bind it to this design thread")
        .addStringOption((o) => o.setName("mode").setDescription("listen = act on relevant talk (default) · address = only when someone says 'Arbiter'").addChoices({ name: "listen", value: "listen" }, { name: "address", value: "address" })),
    )
    .addSubcommand((sc) =>
      sc
        .setName("mode")
        .setDescription("Switch how much Arbiter reacts to")
        .addStringOption((o) => o.setName("mode").setDescription("listen or address").setRequired(true).addChoices({ name: "listen", value: "listen" }, { name: "address", value: "address" })),
    )
    .addSubcommand((sc) => sc.setName("leave").setDescription("Stop listening")),
].map((c) => c.toJSON());
