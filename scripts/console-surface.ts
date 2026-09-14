import type { Surface } from "../src/surface.js";
import type { Fork, Project, Question, Version } from "../src/types.js";
import { tallyText } from "../src/discord/ui.js";

/** Prints what Discord would show. Lets the whole agent run with no bot token. */
export class ConsoleSurface implements Surface {
  public log: string[] = [];
  private say(s: string): void {
    this.log.push(s);
    console.log(`\x1b[36m[thread]\x1b[0m ${s}`);
  }
  mention(userId: string, project?: Project): string {
    return `@${project?.participants[userId]?.name ?? userId}`;
  }
  async postText(_p: Project, text: string): Promise<void> {
    this.say(text);
  }
  async postVersion(p: Project, v: Version, png: Buffer): Promise<{ messageId?: string }> {
    this.say(`📐 ${v.id} — ${v.summary}\n   changes: ${v.changes.join("; ") || "—"}\n   for: ${v.addresses.join(", ") || "—"}\n   ${v.previewUrl}  (png ${png.length} bytes → data/projects/${p.id}/${v.id}.png)`);
    return { messageId: `m_${v.id}` };
  }
  async postFork(p: Project, f: Fork, png: Buffer): Promise<{ messageId?: string }> {
    this.say(`🔀 FORK ${f.id}: ${f.question}\n   A "${f.a.label}" (${f.a.champion}): ${f.a.rationale}\n   B "${f.b.label}" (${f.b.champion}): ${f.b.rationale}\n   compare png ${png.length} bytes → data/projects/${p.id}/${f.id}.png`);
    return { messageId: `m_${f.id}` };
  }
  async updateForkTally(p: Project, f: Fork): Promise<void> {
    this.say(`🗳️ ${tallyText(p, f)}`);
  }
  async postQuestion(p: Project, q: Question, ids: string[]): Promise<void> {
    this.say(`❓ ${ids.length ? ids.map((i) => this.mention(i, p)).join(" ") : q.to} — ${q.text}`);
  }
  async postFiles(_p: Project, files: { name: string; data: Buffer }[], text: string): Promise<void> {
    this.say(`${text}\n   files: ${files.map((f) => `${f.name} (${f.data.length}b)`).join(", ")}`);
  }
  async typing(): Promise<void> {}
}
