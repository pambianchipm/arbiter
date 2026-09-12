import {
  ChannelType,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  GuildMember,
  MessageFlags,
  Partials,
  ThreadAutoArchiveDuration,
  type Attachment,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Interaction,
  type Message,
  type ModalSubmitInteraction,
} from "discord.js";
import type { Orchestrator } from "../orchestrator.js";
import type { ImageInput, Role } from "../types.js";
import { approvalsFooter, feedbackModal } from "./ui.js";
import { registerCommands } from "./register.js";
import { log, errMsg } from "../log.js";

export function createDiscordClient(): Client {
  return new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
    partials: [Partials.Channel, Partials.Message],
  });
}

/** Map a member's Discord roles onto Arbiter roles, so a server that already has roles needs zero setup. */
export function inferRole(member: unknown): Role | undefined {
  if (!(member instanceof GuildMember)) return undefined;
  const names = member.roles.cache.map((r) => r.name.toLowerCase());
  if (names.some((n) => /design/.test(n))) return "designer";
  if (names.some((n) => /(^|\b)(pm|product)(\b|$)/.test(n))) return "pm";
  if (names.some((n) => /(eng|dev|frontend|backend)/.test(n))) return "eng";
  return undefined;
}

function displayName(i: { member: unknown; user: { globalName: string | null; username: string } }): string {
  if (i.member instanceof GuildMember) return i.member.displayName;
  return i.user.globalName ?? i.user.username;
}

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

/** Fetch up to 4 image attachments, downscaled through Discord's media proxy so phone photos fit Claude's limits. */
export async function collectImages(attachments: Attachment[], caption?: string): Promise<ImageInput[]> {
  const out: ImageInput[] = [];
  for (const a of attachments) {
    if (out.length >= 4) break;
    const type = (a.contentType ?? "").split(";")[0].trim();
    if (!IMAGE_TYPES.has(type)) continue;
    try {
      let url = a.proxyURL || a.url;
      const long = Math.max(a.width ?? 0, a.height ?? 0);
      if (a.proxyURL && long > 1568 && a.width && a.height) {
        const k = 1568 / long;
        const u = new URL(a.proxyURL);
        u.searchParams.set("width", String(Math.round(a.width * k)));
        u.searchParams.set("height", String(Math.round(a.height * k)));
        url = u.toString();
      }
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > 4_500_000) {
        log.warn(`skipping ${a.name}: ${buf.length} bytes after resize`);
        continue;
      }
      out.push({ media_type: type as ImageInput["media_type"], data: buf.toString("base64"), caption: caption ?? a.name });
    } catch (e) {
      log.warn(`could not fetch attachment ${a.name}: ${errMsg(e)}`);
    }
  }
  return out;
}

function threadName(brief: string): string {
  const t = `🎨 ${brief.replace(/\s+/g, " ").trim()}`;
  return t.length > 100 ? t.slice(0, 97) + "…" : t;
}

export function attachHandlers(client: Client, orch: Orchestrator): void {
  client.once(Events.ClientReady, async (c) => {
    log.info(`discord ready as ${c.user.tag}`);
    try {
      await registerCommands();
    } catch (e) {
      log.error("command registration failed", errMsg(e));
    }
  });

  client.on(Events.MessageCreate, (m) => {
    void onMessage(client, orch, m).catch((e) => log.error("message handler", errMsg(e)));
  });

  client.on(Events.InteractionCreate, (i) => {
    void onInteraction(orch, i).catch((e) => log.error("interaction handler", errMsg(e)));
  });

  client.on(Events.Error, (e) => log.error("discord client", errMsg(e)));
}

async function onMessage(client: Client, orch: Orchestrator, m: Message): Promise<void> {
  if (m.author.bot) return;
  const me = client.user;
  if (!me) return;

  // Feedback inside a project thread
  if (m.channel.isThread() && orch.has(m.channel.id)) {
    const text = m.content.replace(new RegExp(`<@!?${me.id}>`, "g"), "").trim();
    const images = await collectImages([...m.attachments.values()]);
    if (!text && !images.length) return;
    await m.react("👀").catch(() => undefined);
    await orch.addHumanMessage(m.channel.id, {
      userId: m.author.id,
      name: displayName({ member: m.member, user: m.author }),
      text: text || "(image)",
      images,
      role: inferRole(m.member),
    });
    return;
  }

  // Kickoff by mention in a normal channel
  if (m.mentions.has(me) && !m.channel.isThread() && m.channel.type === ChannelType.GuildText) {
    const brief = m.content.replace(new RegExp(`<@!?${me.id}>`, "g"), "").trim();
    const images = await collectImages([...m.attachments.values()], "sketch attached with the brief");
    if (!brief && !images.length) {
      await m.reply("Tell me what to build: `@Arbiter landing page for a coffee subscription` (attach a whiteboard photo if you have one), or use `/design`.");
      return;
    }
    const thread = await m.startThread({ name: threadName(brief || "sketch"), autoArchiveDuration: ThreadAutoArchiveDuration.OneDay });
    const urlInBrief = /(https?:\/\/\S+)/.exec(brief)?.[1];
    await orch.startProject({
      threadId: thread.id,
      channelId: m.channel.id,
      guildId: m.guildId ?? undefined,
      brief: brief || "Build what the attached sketch shows.",
      referenceUrl: urlInBrief,
      createdBy: { id: m.author.id, name: displayName({ member: m.member, user: m.author }), role: inferRole(m.member) },
      images,
    });
    return;
  }

  if (m.mentions.has(me) && m.channel.isThread()) {
    await m.reply("Mention me in a channel (not inside a thread) to start a new design session, or use `/design`.");
  }
}

async function onInteraction(orch: Orchestrator, i: Interaction): Promise<void> {
  if (i.isChatInputCommand()) return onCommand(orch, i);
  if (i.isButton()) return onButton(orch, i);
  if (i.isModalSubmit()) return onModal(orch, i);
}

async function onCommand(orch: Orchestrator, i: ChatInputCommandInteraction): Promise<void> {
  const name = displayName(i);
  const inProject = i.channel?.isThread() && orch.has(i.channel.id) ? i.channel.id : undefined;

  switch (i.commandName) {
    case "design": {
      const brief = i.options.getString("brief", true);
      const sketch = i.options.getAttachment("sketch");
      const reference = i.options.getString("reference") ?? undefined;
      const ch = i.channel;
      if (!ch || ch.type !== ChannelType.GuildText) {
        await i.reply({ content: "Run `/design` in a regular text channel; I'll open a thread for the session.", flags: MessageFlags.Ephemeral });
        return;
      }
      await i.deferReply();
      const thread = await ch.threads.create({ name: threadName(brief), autoArchiveDuration: ThreadAutoArchiveDuration.OneDay, reason: "Arbiter design session" });
      const images = sketch ? await collectImages([sketch], "sketch attached with the brief") : [];
      await orch.startProject({
        threadId: thread.id,
        channelId: ch.id,
        guildId: i.guildId ?? undefined,
        brief,
        referenceUrl: reference,
        createdBy: { id: i.user.id, name, role: inferRole(i.member) },
        images,
      });
      await i.editReply(`Started ${thread.toString()} — **${brief}**${sketch ? " (with sketch)" : ""}${reference ? ` · reference ${reference}` : ""}`);
      return;
    }
    case "role": {
      const role = i.options.getString("role", true) as Role;
      await orch.setRole(i.guildId ?? undefined, inProject, i.user.id, name, role);
      await i.reply({ content: `Got it — you're the **${role}**${inProject ? " on this session" : " on this server"}.`, flags: MessageFlags.Ephemeral });
      return;
    }
    case "constraint": {
      if (!inProject) {
        await i.reply({ content: "Run `/constraint` inside a design thread.", flags: MessageFlags.Ephemeral });
        return;
      }
      const text = i.options.getString("text", true);
      await i.reply({ content: `🔒 **${name}** added a constraint: ${text}` });
      await orch.addConstraint(inProject, text, i.user.id, name);
      return;
    }
    case "handoff": {
      if (!inProject) {
        await i.reply({ content: "Run `/handoff` inside a design thread.", flags: MessageFlags.Ephemeral });
        return;
      }
      await i.deferReply({ flags: MessageFlags.Ephemeral });
      await orch.handoff(inProject, i.options.getString("stack") ?? undefined);
      await i.editReply("Posted the handoff.");
      return;
    }
    case "status": {
      if (!inProject) {
        await i.reply({ content: "Run `/status` inside a design thread.", flags: MessageFlags.Ephemeral });
        return;
      }
      const text = (await orch.statusText(inProject)) ?? "No project here.";
      await i.reply({ content: text, flags: MessageFlags.Ephemeral });
      return;
    }
  }
}

async function onButton(orch: Orchestrator, i: ButtonInteraction): Promise<void> {
  const name = displayName(i);
  const projectId = i.channel?.isThread() ? i.channel.id : undefined;
  if (!projectId || !orch.has(projectId)) {
    await i.reply({ content: "This session is no longer tracked.", flags: MessageFlags.Ephemeral });
    return;
  }
  const [action, arg, arg2] = i.customId.split(":");

  if (action === "approve" && arg) {
    // Acknowledge within Discord's 3s window before doing any work.
    await i.deferUpdate();
    const r = await orch.approve(projectId, arg, i.user.id, name);
    if (!r.ok) {
      await i.followUp({ content: r.reason ?? "Could not approve.", flags: MessageFlags.Ephemeral });
      return;
    }
    const p = await orch.get(projectId);
    const v = p?.versions.find((x) => x.id === arg);
    const embed = i.message.embeds[0];
    if (p && v && embed) {
      await i.editReply({ embeds: [EmbedBuilder.from(embed).setFooter({ text: approvalsFooter(p, v) })] }).catch((e) => log.warn("footer update", errMsg(e)));
    }
    await i.followUp({ content: `✅ You approved ${arg} (${r.count}/${r.total}).`, flags: MessageFlags.Ephemeral });
    return;
  }

  if (action === "feedback" && arg) {
    await i.showModal(feedbackModal(arg));
    return;
  }

  if (action === "handoff") {
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    await orch.handoff(projectId);
    await i.editReply("Posted the handoff.");
    return;
  }

  if (action === "vote" && arg && (arg2 === "a" || arg2 === "b")) {
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    const r = await orch.vote(projectId, arg, i.user.id, name, arg2);
    await i.editReply(r.ok ? `🗳️ You voted ${arg2.toUpperCase()}.${r.resolved ? " Everyone has voted — building the winner." : ""}` : `Could not vote: ${r.reason}`);
    return;
  }

  if (action === "resolve" && arg) {
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    const r = await orch.resolveFork(projectId, arg, name);
    await i.editReply(r.ok ? "⚖️ Resolving with the votes in so far." : `Could not resolve: ${r.reason}`);
    return;
  }

  await i.reply({ content: "Unknown button.", flags: MessageFlags.Ephemeral });
}

async function onModal(orch: Orchestrator, i: ModalSubmitInteraction): Promise<void> {
  const name = displayName(i);
  const projectId = i.channel?.isThread() ? i.channel.id : undefined;
  if (!projectId || !orch.has(projectId)) {
    await i.reply({ content: "This session is no longer tracked.", flags: MessageFlags.Ephemeral });
    return;
  }
  const [action, versionId] = i.customId.split(":");
  if (action !== "feedback_modal") return;
  const text = i.fields.getTextInputValue("text").trim();
  // Public on purpose: the whole team should see every piece of feedback the agent acts on.
  await i.reply({ content: `✏️ **${name}** on ${versionId}: ${text}`.slice(0, 2000) });
  await orch.addHumanMessage(projectId, { userId: i.user.id, name, text: `Feedback on ${versionId}: ${text}`, role: inferRole(i.member) });
}
