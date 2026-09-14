import { SlashCommandBuilder } from "discord.js";
import { ROLES } from "../types.js";

export const commands = [
  new SlashCommandBuilder()
    .setName("design")
    .setDescription("Start a design session in a new thread: Arbiter builds v1 and iterates with the team")
    .addStringOption((o) => o.setName("brief").setDescription("What are we building? e.g. 'landing page for a coffee subscription'").setRequired(true).setMaxLength(600))
    .addAttachmentOption((o) => o.setName("sketch").setDescription("Whiteboard photo or napkin sketch — used as the layout spec"))
    .addStringOption((o) => o.setName("reference").setDescription("A site to take the feel from, e.g. https://linear.app")),
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
].map((c) => c.toJSON());
