/** Domain types for an Arbiter project (one Discord thread == one project). */

export type Role = "designer" | "pm" | "eng" | "stakeholder";
export const ROLES: Role[] = ["designer", "pm", "eng", "stakeholder"];

export interface Participant {
  id: string;
  name: string;
  role?: Role;
}

export interface ImageInput {
  media_type: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
  data: string; // base64
  caption?: string;
}

export interface TranscriptEntry {
  id: string;
  at: string;
  kind: "human" | "agent" | "system";
  userId?: string;
  name: string;
  role?: Role;
  text: string;
  imageCount?: number;
  /** "voice" when this line came from a voice-channel transcript */
  via?: "voice";
  /** true once an agent turn has consumed this entry */
  seen?: boolean;
}

export interface Version {
  id: string; // v1, v2 … or v3a / v3b for fork variants
  parent?: string;
  label?: string; // fork variant label
  summary: string;
  changes: string[];
  addresses: string[]; // names whose feedback this version acts on
  createdAt: string;
  previewUrl: string;
  messageId?: string;
  approvals: string[]; // user ids
  renderWarnings?: string[];
}

export interface ForkSide {
  versionId: string;
  label: string;
  rationale: string;
  /** who this variant is faithful to */
  champion?: string;
}

export interface Fork {
  id: string;
  question: string;
  a: ForkSide;
  b: ForkSide;
  votes: Record<string, "a" | "b">;
  openedAt: string;
  messageId?: string;
  resolved?: { at: string; winner: "a" | "b" | "tie"; by: string };
}

export interface Decision {
  id: string;
  at: string;
  summary: string;
  rationale: string;
  requestedBy: string[];
  versionId?: string;
}

export interface Constraint {
  id: string;
  text: string;
  source: string;
  at: string;
}

export interface Question {
  id: string;
  at: string;
  text: string;
  to: string; // role, "everyone", or a display name
  answered?: boolean;
}

export interface StyleNotes {
  source?: string;
  summary: string;
  palette?: string[];
  typography?: string;
  spacing?: string;
  vibe?: string;
}

/** Persists across threads: the team's design system as the agent has learned it. One per server by default, more by name. */
export interface Brand {
  id: string; // slug, unique within the guild
  guildId: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  style?: StyleNotes;
  /** header/footer/head HTML lifted from the last approved page, reused verbatim on new pages */
  chrome?: { header?: string; footer?: string; head?: string; fromThread: string; fromVersion: string; at: string };
  voice?: string;
  constraints: Constraint[];
  decisions: Decision[];
  pages: { threadId: string; brief: string; versionId: string; previewUrl: string; shippedAt: string }[];
  people: Record<string, { name: string; role?: Role }>;
}

export type Plan = "free" | "team" | "byok";

/** Per-server commercial state. Files now, a table later. */
export interface GuildSettings {
  guildId: string;
  plan: Plan;
  rendersRemaining: number;
  renewsAt: string;
  /** pack renders: spent after the monthly allowance, never reset */
  bonusRenders?: number;
  /** encrypted with ARBITER_SECRET; never logged or echoed */
  byokKeyEnc?: string;
  stripeCustomerId?: string;
  stripeSubscriptionId?: string;
  /** last Stripe event ids applied, for idempotent webhooks */
  stripeEvents?: string[];
  /** set once the welcome message has been posted */
  welcomedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Project {
  id: string; // == threadId
  /** unguessable suffix for preview/canvas URLs when hosted */
  token?: string;
  brandId?: string;
  guildId?: string;
  channelId: string;
  threadId: string;
  brief: string;
  referenceUrl?: string;
  createdBy: Participant;
  createdAt: string;
  participants: Record<string, Participant>;
  versions: Version[];
  currentVersionId?: string;
  fork?: Fork;
  forkHistory: Fork[];
  constraints: Constraint[];
  decisions: Decision[];
  questions: Question[];
  style?: StyleNotes;
  transcript: TranscriptEntry[];
  status: "active" | "shipped";
  turnCount: number;
  /** version id a nudge was already sent for */
  nudgedFor?: string;
  /** persisted so any process (and the live canvas) can show what the agent is doing or why it failed */
  lastTurn?: { startedAt: string; endedAt?: string; reason: string; error?: string; toolCalls?: number; ms?: number };
  /** set while Arbiter is listening in a voice channel for this thread */
  voice?: { channelId: string; channelName: string; since: string; mode?: "listen" | "address" };
}

export type TurnReason =
  | { kind: "kickoff" }
  | { kind: "feedback" }
  | { kind: "fork_resolved"; forkId: string; winner: "a" | "b" | "tie"; tally: { a: number; b: number }; by: string }
  | { kind: "manual"; note: string };

export interface TurnInput {
  project: Project;
  reason: TurnReason;
  images: ImageInput[];
  /** HTML of the current version, if any (the model edits from this) */
  currentHtml?: string;
  /** the server's brand memory, if this project is bound to one */
  brand?: Brand;
}

export interface TurnResult {
  text: string;
  toolCalls: number;
  iterations: number;
  publishedVersionIds: string[];
  forkOpened?: string;
  error?: string;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function shortId(prefix = ""): string {
  return prefix + Math.random().toString(36).slice(2, 8);
}

export function currentVersion(p: Project): Version | undefined {
  return p.versions.find((v) => v.id === p.currentVersionId);
}

export function humanParticipants(p: Project): Participant[] {
  return Object.values(p.participants);
}

export function participantsWithRole(p: Project, role: Role): Participant[] {
  return humanParticipants(p).filter((x) => x.role === role);
}

export function nextVersionNumber(p: Project): number {
  let max = 0;
  for (const v of p.versions) {
    const m = /^v(\d+)/.exec(v.id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max + 1;
}
