import type { Fork, Project, Question, Version } from "./types.js";

/**
 * Everything the agent needs from "the place it lives". Discord implements this;
 * the console implementation (scripts/) runs the same agent without a bot token.
 */
export interface Surface {
  postText(project: Project, text: string): Promise<void>;
  postVersion(project: Project, version: Version, png: Buffer): Promise<{ messageId?: string }>;
  postFork(project: Project, fork: Fork, png: Buffer): Promise<{ messageId?: string }>;
  updateForkTally(project: Project, fork: Fork): Promise<void>;
  postQuestion(project: Project, question: Question, mentionUserIds: string[]): Promise<void>;
  postFiles(project: Project, files: { name: string; data: Buffer }[], text: string): Promise<void>;
  /** best-effort typing indicator while a turn runs */
  typing(project: Project): Promise<void>;
  /** format a user mention for this surface */
  mention(userId: string, project?: Project): string;
}
