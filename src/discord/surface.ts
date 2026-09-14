import { AttachmentBuilder, type Client, type SendableChannels } from "discord.js";
import type { Surface } from "../surface.js";
import type { Fork, Project, Question, Version } from "../types.js";
import { chunk, forkEdit, forkMessage, versionMessage } from "./ui.js";
import { log, errMsg } from "../log.js";
import { explainDiscordError } from "./errors.js";

export class DiscordSurface implements Surface {
  constructor(private readonly client: Client) {}

  private async channel(p: Project): Promise<SendableChannels> {
    const ch = await this.client.channels.fetch(p.threadId).catch((e) => {
      throw new Error(explainDiscordError(e));
    });
    if (!ch || !ch.isSendable()) throw new Error(`thread ${p.threadId} is not a sendable channel`);
    if (ch.isThread() && ch.archived) await ch.setArchived(false).catch(() => undefined);
    return ch;
  }

  /** send with Discord errors translated into instructions */
  private async send(ch: SendableChannels, payload: Parameters<SendableChannels["send"]>[0]) {
    try {
      return await ch.send(payload);
    } catch (e) {
      throw new Error(explainDiscordError(e));
    }
  }

  mention(userId: string): string {
    return `<@${userId}>`;
  }

  async postText(p: Project, text: string): Promise<void> {
    const ch = await this.channel(p);
    for (const part of chunk(text)) {
      await this.send(ch, { content: part, allowedMentions: { parse: ["users"] } });
    }
  }

  async postVersion(p: Project, version: Version, png: Buffer): Promise<{ messageId?: string }> {
    const ch = await this.channel(p);
    const msg = await this.send(ch, versionMessage(p, version, png));
    return { messageId: msg.id };
  }

  async postFork(p: Project, fork: Fork, png: Buffer): Promise<{ messageId?: string }> {
    const ch = await this.channel(p);
    const msg = await this.send(ch, forkMessage(p, fork, png));
    return { messageId: msg.id };
  }

  async updateForkTally(p: Project, fork: Fork): Promise<void> {
    if (!fork.messageId) return;
    try {
      const ch = await this.channel(p);
      const msg = await ch.messages.fetch(fork.messageId);
      await msg.edit(forkEdit(p, fork));
    } catch (e) {
      log.warn("could not update fork tally", errMsg(e));
    }
  }

  async postQuestion(p: Project, q: Question, mentionUserIds: string[]): Promise<void> {
    const ch = await this.channel(p);
    const who = mentionUserIds.length ? mentionUserIds.map((id) => `<@${id}>`).join(" ") : `**${q.to}**`;
    await this.send(ch, { content: `❓ ${who} — ${q.text}`.slice(0, 2000), allowedMentions: { users: mentionUserIds } });
  }

  async postFiles(p: Project, files: { name: string; data: Buffer }[], text: string): Promise<void> {
    const ch = await this.channel(p);
    await this.send(ch, { content: text.slice(0, 2000), files: files.map((f) => new AttachmentBuilder(f.data, { name: f.name })) });
  }

  async typing(p: Project): Promise<void> {
    try {
      const ch = await this.channel(p);
      await ch.sendTyping();
    } catch {
      /* typing is best-effort */
    }
  }
}
