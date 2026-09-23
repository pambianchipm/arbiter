import {
  ActionRowBuilder,
  StringSelectMenuBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type MessageCreateOptions,
  type MessageEditOptions,
} from "discord.js";
import type { Fork, Project, Version } from "../types.js";

export const COLORS = { version: 0x3b82f6, fork: 0xec4899, ok: 0x22c55e, warn: 0xf59e0b };

export function isPublicUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return !["localhost", "127.0.0.1", "0.0.0.0"].includes(u.hostname);
  } catch {
    return false;
  }
}

function bullets(items: string[], max = 6): string {
  const shown = items.slice(0, max).map((s) => `• ${s}`);
  if (items.length > max) shown.push(`• …and ${items.length - max} more`);
  return shown.join("\n").slice(0, 1000) || "—";
}

export function approvalsFooter(project: Project, version: Version): string {
  const total = Object.keys(project.participants).length;
  const names = version.approvals.map((id) => project.participants[id]?.name ?? id);
  const base = `Approvals ${version.approvals.length}/${total}${names.length ? ` (${names.join(", ")})` : ""}`;
  return isPublicUrl(version.previewUrl) ? base : `${base} · live: ${version.previewUrl}`;
}

export function versionMessage(project: Project, version: Version, png: Buffer): MessageCreateOptions {
  const file = new AttachmentBuilder(png, { name: `${version.id}.png` });
  const embed = new EmbedBuilder()
    .setColor(COLORS.version)
    .setTitle(`${version.id} — ${version.summary}`.slice(0, 256))
    .setImage(`attachment://${version.id}.png`)
    .setFooter({ text: approvalsFooter(project, version) });
  if (isPublicUrl(version.previewUrl)) embed.setURL(version.previewUrl);
  if (version.changes.length) embed.addFields({ name: "Changes", value: bullets(version.changes) });
  if (version.addresses.length) embed.addFields({ name: "Acting on feedback from", value: version.addresses.join(", ").slice(0, 1000), inline: true });
  if (version.renderWarnings?.length) embed.addFields({ name: "Render notes", value: bullets(version.renderWarnings, 3) });

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`approve:${version.id}`).setLabel("Approve").setEmoji("✅").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`feedback:${version.id}`).setLabel("Feedback").setEmoji("✏️").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("handoff").setLabel("Handoff").setEmoji("📦").setStyle(ButtonStyle.Secondary),
  );
  if (isPublicUrl(version.previewUrl)) {
    row.addComponents(new ButtonBuilder().setLabel("Open live").setStyle(ButtonStyle.Link).setURL(version.previewUrl));
  }
  return { embeds: [embed], files: [file], components: [row] };
}

export function tallyText(project: Project, fork: Fork): string {
  const a = Object.values(fork.votes).filter((v) => v === "a").length;
  const b = Object.values(fork.votes).filter((v) => v === "b").length;
  const who = Object.entries(fork.votes)
    .map(([id, v]) => `${project.participants[id]?.name ?? id} → ${v.toUpperCase()}`)
    .join(", ");
  if (fork.resolved) {
    const w = fork.resolved.winner === "tie" ? "Tie — role rule applies" : `${fork.resolved.winner.toUpperCase()} wins`;
    return `Resolved by ${fork.resolved.by}: ${w} (A ${a} · B ${b})${who ? ` — ${who}` : ""}`;
  }
  return `Vote open: A ${a} · B ${b}${who ? ` — ${who}` : ""}`;
}

function forkEmbed(project: Project, fork: Fork, withImage: boolean): EmbedBuilder {
  const e = new EmbedBuilder()
    .setColor(fork.resolved ? COLORS.ok : COLORS.fork)
    .setTitle(`🔀 Conflict — ${fork.question}`.slice(0, 256))
    .addFields(
      { name: `🅰 ${fork.a.label}`, value: `${fork.a.rationale}${fork.a.champion ? `\n_for ${fork.a.champion}_` : ""}`.slice(0, 1024), inline: true },
      { name: `🅱 ${fork.b.label}`, value: `${fork.b.rationale}${fork.b.champion ? `\n_for ${fork.b.champion}_` : ""}`.slice(0, 1024), inline: true },
    )
    .setFooter({ text: tallyText(project, fork) });
  if (withImage) e.setImage(`attachment://${fork.id}.png`);
  const va = project.versions.find((v) => v.id === fork.a.versionId);
  if (va && isPublicUrl(va.previewUrl)) {
    const vb = project.versions.find((v) => v.id === fork.b.versionId);
    e.setDescription(`[Open A](${va.previewUrl})${vb ? ` · [Open B](${vb.previewUrl})` : ""}`);
  }
  return e;
}

function forkButtons(fork: Fork): ActionRowBuilder<ButtonBuilder> {
  const done = Boolean(fork.resolved);
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`vote:${fork.id}:a`).setLabel("Vote A").setEmoji("🅰").setStyle(ButtonStyle.Primary).setDisabled(done),
    new ButtonBuilder().setCustomId(`vote:${fork.id}:b`).setLabel("Vote B").setEmoji("🅱").setStyle(ButtonStyle.Primary).setDisabled(done),
    new ButtonBuilder().setCustomId(`resolve:${fork.id}`).setLabel("Resolve now").setEmoji("⚖️").setStyle(ButtonStyle.Secondary).setDisabled(done),
  );
}

export function forkMessage(project: Project, fork: Fork, png: Buffer): MessageCreateOptions {
  const file = new AttachmentBuilder(png, { name: `${fork.id}.png` });
  return { embeds: [forkEmbed(project, fork, true)], files: [file], components: [forkButtons(fork)] };
}

export function forkEdit(project: Project, fork: Fork): MessageEditOptions {
  // Existing attachment stays on the message when `files` is omitted, so attachment:// still resolves.
  return { embeds: [forkEmbed(project, fork, true)], components: [forkButtons(fork)] };
}

export function feedbackModal(versionId: string): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(`feedback_modal:${versionId}`)
    .setTitle(`Feedback on ${versionId}`.slice(0, 45))
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("text")
          .setLabel("What should change, and why?")
          .setStyle(TextInputStyle.Paragraph)
          .setPlaceholder("e.g. Move pricing above testimonials — price is the first question visitors ask.")
          .setRequired(true)
          .setMaxLength(1000),
      ),
    );
}

export function chunk(text: string, size = 1900): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > size) {
    let cut = rest.lastIndexOf("\n", size);
    if (cut < size * 0.5) cut = size;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, "");
  }
  if (rest) out.push(rest);
  return out;
}


export function welcomeEmbed(info: { metering: boolean; freeRenders: number }): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(COLORS.version)
    .setTitle("👋 Arbiter is here")
    .setDescription(
      "I'm a design agent for your team. Describe a page, I build a live prototype in about a minute, and everyone iterates in the thread. When two of you want opposite things, I build both and you vote.",
    )
    .addFields(
      { name: "1 · Start", value: "Hit **✨ Start a design session** below, or type `/design brief: landing page for …` in any channel. You can attach a whiteboard photo or name a site to borrow the feel from." },
      { name: "2 · Iterate", value: "Reply in the thread, or `/voice join` and talk. Pick your role in the menu below so questions go to the right person." },
      { name: "3 · Ship", value: "✅ Approve when it's right, then 📦 Handoff for a zip your coding agent can build from. Approved pages teach me your brand." },
      {
        name: "Plan",
        value: info.metering
          ? `Free includes ${info.freeRenders} renders a month (a render is one version or A/B variant). \`/plan\` to upgrade, or \`/setup\` to use your own Anthropic key for unlimited.`
          : "Renders are unlimited on this Arbiter.",
      },
    )
    .setFooter({ text: "/help shows this again · /forget deletes a session" });
}


export const ROLE_OPTIONS = [
  { label: "Designer", value: "designer", description: "Visual calls come to you; you break visual ties", emoji: "🎨" },
  { label: "Product / PM", value: "pm", description: "Content and priority calls come to you", emoji: "🧭" },
  { label: "Engineer", value: "eng", description: "Feasibility questions and constraints come to you", emoji: "🛠️" },
  { label: "Stakeholder", value: "stakeholder", description: "You weigh in; no tiebreak duty", emoji: "👀" },
];

export function roleMenuRow(): ActionRowBuilder<StringSelectMenuBuilder> {
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder().setCustomId("role_pick").setPlaceholder("What's your role? I'll route questions to you").addOptions(ROLE_OPTIONS),
  );
}

/** Buttons under the welcome and /help messages. */
export function onboardingRows(siteUrl?: string): ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[] {
  const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("onboard_start").setLabel("Start a design session").setEmoji("✨").setStyle(ButtonStyle.Primary),
  );
  if (siteUrl && isPublicUrl(siteUrl)) buttons.addComponents(new ButtonBuilder().setLabel("How it works").setStyle(ButtonStyle.Link).setURL(siteUrl));
  return [buttons as ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>, roleMenuRow() as ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>];
}

export function startModal(): ModalBuilder {
  return new ModalBuilder()
    .setCustomId("start_modal")
    .setTitle("Start a design session")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("brief")
          .setLabel("What are we building?")
          .setStyle(TextInputStyle.Paragraph)
          .setPlaceholder("e.g. A landing page for our coffee subscription: hero, how it works, three plans, FAQ.")
          .setRequired(true)
          .setMinLength(8)
          .setMaxLength(600),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("reference")
          .setLabel("A site whose feel you like (optional)")
          .setStyle(TextInputStyle.Short)
          .setPlaceholder("https://linear.app")
          .setRequired(false)
          .setMaxLength(200),
      ),
    );
}

export function upgradeRow(url: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setLabel("Upgrade or buy renders").setEmoji("⚡").setStyle(ButtonStyle.Link).setURL(url));
}
