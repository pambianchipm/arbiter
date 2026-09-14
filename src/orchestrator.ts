import type { Store } from "./store.js";
import type { Screenshotter } from "./render/screenshot.js";
import type { Surface } from "./surface.js";
import type { Agent } from "./agent/run.js";
import type { ToolContext } from "./agent/tools.js";
import type { Fork, ImageInput, Participant, Project, Role, TurnReason, TurnResult, Version } from "./types.js";
import { currentVersion, nowIso, shortId } from "./types.js";
import { generateBuildBrief, generateHandoff } from "./handoff.js";
import { log, errMsg } from "./log.js";

export interface OrchestratorConfig {
  baseUrl: string;
  debounceMs: number;
  nudgeMinutes: number;
  forkTimeoutMinutes: number;
}

export interface HumanMessage {
  userId: string;
  name: string;
  text: string;
  images?: ImageInput[];
  /** explicit role override (e.g. inferred from Discord roles) */
  role?: Role;
}

/**
 * The hub. Owns per-project queues so exactly one agent turn runs per thread at a time,
 * batches near-simultaneous messages into one turn (so a disagreement arrives as a pair),
 * runs vote/nudge timers, and exposes the button/command actions the surface calls.
 */
export class Orchestrator {
  private pendingImages = new Map<string, ImageInput[]>();
  private debounce = new Map<string, NodeJS.Timeout>();
  private nudgeTimers = new Map<string, NodeJS.Timeout>();
  private forkTimers = new Map<string, NodeJS.Timeout>();
  private running = new Set<string>();
  private queued = new Map<string, TurnReason>();

  constructor(
    private readonly store: Store,
    private readonly shots: Screenshotter,
    private readonly surface: Surface,
    private readonly agent: Agent,
    private readonly cfg: OrchestratorConfig,
  ) {}

  async resume(): Promise<number> {
    const all = await this.store.loadAll();
    log.info(`resumed ${all.length} project(s) from ${this.store.dir}`);
    return all.length;
  }

  has(projectId: string): boolean {
    return this.store.has(projectId);
  }

  async get(projectId: string): Promise<Project | undefined> {
    return this.store.load(projectId);
  }

  // ---------------------------------------------------------------- lifecycle

  async startProject(args: {
    threadId: string;
    channelId: string;
    guildId?: string;
    brief: string;
    referenceUrl?: string;
    createdBy: { id: string; name: string; role?: Role };
    images?: ImageInput[];
  }): Promise<Project> {
    const role = args.createdBy.role ?? (args.guildId ? (await this.store.getRoles(args.guildId))[args.createdBy.id] : undefined);
    const creator: Participant = { id: args.createdBy.id, name: args.createdBy.name, role };
    const p: Project = {
      id: args.threadId,
      threadId: args.threadId,
      channelId: args.channelId,
      guildId: args.guildId,
      brief: args.brief.trim(),
      referenceUrl: args.referenceUrl,
      createdBy: creator,
      createdAt: nowIso(),
      participants: { [creator.id]: creator },
      versions: [],
      forkHistory: [],
      constraints: [],
      decisions: [],
      questions: [],
      transcript: [
        {
          id: shortId("t_"),
          at: nowIso(),
          kind: "human",
          userId: creator.id,
          name: creator.name,
          role: creator.role,
          text: `Brief: ${args.brief.trim()}${args.referenceUrl ? ` (reference: ${args.referenceUrl})` : ""}`,
          imageCount: args.images?.length || undefined,
          seen: false,
        },
      ],
      status: "active",
      turnCount: 0,
    };
    await this.store.save(p);
    if (args.images?.length) this.pendingImages.set(p.id, [...args.images]);
    await this.surface.postText(
      p,
      `On it. Building v1 from the brief${args.images?.length ? " and your sketch" : ""}. First render usually lands in under a minute.\n📺 Live canvas (screen-share this): ${this.liveUrl(p)}`,
    );
    void this.trigger(p.id, { kind: "kickoff" });
    return p;
  }

  async addHumanMessage(projectId: string, m: HumanMessage): Promise<void> {
    const p = await this.store.load(projectId);
    if (!p) return;
    await this.ensureParticipant(p, m.userId, m.name, m.role);
    const part = p.participants[m.userId];
    p.transcript.push({
      id: shortId("t_"),
      at: nowIso(),
      kind: "human",
      userId: m.userId,
      name: part.name,
      role: part.role,
      text: m.text.trim(),
      imageCount: m.images?.length || undefined,
      seen: false,
    });
    // A reply from a role answers open questions aimed at it.
    for (const q of p.questions) {
      if (q.answered) continue;
      const t = q.to.toLowerCase();
      if (t === "everyone" || t === part.role || t === part.name.toLowerCase()) q.answered = true;
    }
    await this.store.save(p);
    this.cancelNudge(p.id);
    if (m.images?.length) this.pendingImages.set(p.id, [...(this.pendingImages.get(p.id) ?? []), ...m.images]);
    this.scheduleFeedbackTurn(p.id);
  }

  private scheduleFeedbackTurn(projectId: string): void {
    const existing = this.debounce.get(projectId);
    if (existing) clearTimeout(existing);
    this.debounce.set(
      projectId,
      setTimeout(() => {
        this.debounce.delete(projectId);
        void this.trigger(projectId, { kind: "feedback" });
      }, this.cfg.debounceMs),
    );
  }

  /** Run a turn now, or queue it if one is already running for this project. */
  private async trigger(projectId: string, reason: TurnReason): Promise<void> {
    if (this.running.has(projectId)) {
      // Keep the more specific reason if one is queued.
      const prev = this.queued.get(projectId);
      this.queued.set(projectId, prev && prev.kind !== "feedback" ? prev : reason);
      return;
    }
    this.running.add(projectId);
    try {
      let next: TurnReason | undefined = reason;
      while (next) {
        await this.runOne(projectId, next);
        next = this.queued.get(projectId);
        this.queued.delete(projectId);
      }
    } finally {
      this.running.delete(projectId);
    }
  }

  private async runOne(projectId: string, reason: TurnReason): Promise<TurnResult | undefined> {
    const p = await this.store.load(projectId);
    if (!p) return undefined;
    const images = this.pendingImages.get(projectId) ?? [];
    this.pendingImages.delete(projectId);
    const cur = currentVersion(p);
    const currentHtml = cur ? await this.store.readHtml(p.id, cur.id) : undefined;

    const result: TurnResult = { text: "", toolCalls: 0, iterations: 0, publishedVersionIds: [] };
    const ctx: ToolContext = {
      project: p,
      store: this.store,
      shots: this.shots,
      surface: this.surface,
      baseUrl: this.cfg.baseUrl,
      result,
      renderRetries: 0,
      onVersionPublished: (v) => this.scheduleNudge(p.id, v),
      onForkOpened: (f) => this.scheduleForkTimeout(p.id, f),
    };

    const typing = setInterval(() => void this.surface.typing(p), 8_000);
    void this.surface.typing(p);
    this.store.setWorking(p.id, true);
    p.lastTurn = { startedAt: nowIso(), reason: reason.kind };
    await this.store.save(p);
    const t0 = Date.now();
    try {
      await this.agent.runTurn({ project: p, reason, images, currentHtml }, ctx);
    } catch (e) {
      result.error = errMsg(e);
    } finally {
      clearInterval(typing);
      this.store.setWorking(p.id, false);
    }

    for (const t of p.transcript) if (t.kind === "human") t.seen = true;
    p.turnCount++;
    p.lastTurn = { ...(p.lastTurn ?? { startedAt: nowIso(), reason: reason.kind }), endedAt: nowIso(), error: result.error, toolCalls: result.toolCalls, ms: Date.now() - t0 };
    await this.store.save(p);

    if (result.text) await this.surface.postText(p, result.text);
    if (result.error) await this.surface.postText(p, `⚠️ ${result.error}${result.publishedVersionIds.length ? "" : " Nothing was published this turn; reply to try again."}`);
    log.info(`turn done ${p.id} reason=${reason.kind} tools=${result.toolCalls} iters=${result.iterations} ${Date.now() - t0}ms${result.error ? " error=" + result.error : ""}`);
    return result;
  }

  // ---------------------------------------------------------------- votes

  async vote(projectId: string, forkId: string, userId: string, name: string, choice: "a" | "b"): Promise<{ ok: boolean; reason?: string; resolved?: boolean }> {
    const p = await this.store.load(projectId);
    if (!p) return { ok: false, reason: "unknown project" };
    const f = p.fork;
    if (!f || f.id !== forkId || f.resolved) return { ok: false, reason: "that vote is closed" };
    await this.ensureParticipant(p, userId, name);
    f.votes[userId] = choice;
    await this.store.save(p);
    await this.surface.updateForkTally(p, f);
    const voters = new Set(Object.keys(f.votes));
    const everyoneVoted = Object.keys(p.participants).every((id) => voters.has(id));
    if (everyoneVoted && Object.keys(p.participants).length >= 2) {
      await this.resolveFork(projectId, forkId, "everyone voting");
      return { ok: true, resolved: true };
    }
    return { ok: true };
  }

  async resolveFork(projectId: string, forkId: string, by: string): Promise<{ ok: boolean; reason?: string }> {
    const p = await this.store.load(projectId);
    if (!p) return { ok: false, reason: "unknown project" };
    const f = p.fork;
    if (!f || f.id !== forkId || f.resolved) return { ok: false, reason: "that vote is already closed" };
    const a = Object.values(f.votes).filter((v) => v === "a").length;
    const b = Object.values(f.votes).filter((v) => v === "b").length;
    const winner: "a" | "b" | "tie" = a === b ? "tie" : a > b ? "a" : "b";
    f.resolved = { at: nowIso(), winner, by };
    p.forkHistory.push(f);
    p.fork = undefined;
    p.transcript.push({
      id: shortId("t_"),
      at: nowIso(),
      kind: "system",
      name: "system",
      text: `Fork ${f.id} resolved by ${by}: ${winner === "tie" ? "TIE" : winner.toUpperCase() + " wins"} (A ${a}, B ${b}).`,
      seen: false,
    });
    await this.store.save(p);
    this.cancelForkTimeout(p.id);
    await this.surface.updateForkTally(p, f);
    void this.trigger(p.id, { kind: "fork_resolved", forkId: f.id, winner, tally: { a, b }, by });
    return { ok: true };
  }

  // ---------------------------------------------------------------- approvals, constraints, roles

  async approve(projectId: string, versionId: string, userId: string, name: string): Promise<{ ok: boolean; reason?: string; allApproved?: boolean; count: number; total: number }> {
    const p = await this.store.load(projectId);
    if (!p) return { ok: false, reason: "unknown project", count: 0, total: 0 };
    const v = p.versions.find((x) => x.id === versionId);
    if (!v) return { ok: false, reason: "unknown version", count: 0, total: 0 };
    await this.ensureParticipant(p, userId, name);
    if (!v.approvals.includes(userId)) v.approvals.push(userId);
    const total = Object.keys(p.participants).length;
    const allApproved = v.approvals.length >= total && v.id === p.currentVersionId;
    if (allApproved) p.status = "shipped";
    p.transcript.push({ id: shortId("t_"), at: nowIso(), kind: "system", name: "system", text: `${name} approved ${versionId}${allApproved ? " — everyone has approved" : ""}.`, seen: true });
    await this.store.save(p);
    this.cancelNudge(p.id);
    if (allApproved) await this.surface.postText(p, `✅ ${versionId} approved by everyone (${v.approvals.length}/${total}). Run /handoff for the spec and source.`);
    return { ok: true, allApproved, count: v.approvals.length, total };
  }

  async addConstraint(projectId: string, text: string, userId: string, name: string): Promise<void> {
    const p = await this.store.load(projectId);
    if (!p) return;
    await this.ensureParticipant(p, userId, name);
    p.constraints.push({ id: shortId("c_"), text: text.trim(), source: name, at: nowIso() });
    await this.store.save(p);
    // The agent should see it and, if the current version violates it, act.
    await this.addHumanMessage(projectId, { userId, name, text: `Constraint: ${text.trim()}` });
  }

  async setRole(guildId: string | undefined, projectId: string | undefined, userId: string, name: string, role: Role): Promise<void> {
    if (guildId) await this.store.setRole(guildId, userId, role);
    if (projectId) {
      const p = await this.store.load(projectId);
      if (p) {
        await this.ensureParticipant(p, userId, name, role);
        p.participants[userId].role = role;
        await this.store.save(p);
      }
    }
  }

  private async ensureParticipant(p: Project, userId: string, name: string, role?: Role): Promise<void> {
    const existing = p.participants[userId];
    if (existing) {
      if (role && !existing.role) existing.role = role;
      return;
    }
    const guildRole = p.guildId ? (await this.store.getRoles(p.guildId))[userId] : undefined;
    p.participants[userId] = { id: userId, name, role: role ?? guildRole };
  }

  // ---------------------------------------------------------------- handoff & status

  liveUrl(p: Project): string {
    return `${this.cfg.baseUrl}/live/${p.id}`;
  }

  async handoff(projectId: string, stack?: string): Promise<boolean> {
    const p = await this.store.load(projectId);
    if (!p) return false;
    const md = generateHandoff(p);
    const files: { name: string; data: Buffer }[] = [
      { name: `handoff-${p.id}.md`, data: Buffer.from(md, "utf8") },
      { name: `BUILD.md`, data: Buffer.from(generateBuildBrief(p, stack), "utf8") },
    ];
    const cur = currentVersion(p);
    if (cur) {
      const html = await this.store.readHtml(p.id, cur.id);
      if (html) files.push({ name: `${cur.id}.html`, data: Buffer.from(html, "utf8") });
      const png = await this.store.readPng(p.id, cur.id);
      if (png) files.push({ name: `${cur.id}.png`, data: png });
    }
    await this.surface.postFiles(
      p,
      files,
      `📦 Handoff for **${p.brief}** — ${p.decisions.length} decision${p.decisions.length === 1 ? "" : "s"}, ${p.constraints.length} constraint${p.constraints.length === 1 ? "" : "s"}, ${p.versions.length} version${p.versions.length === 1 ? "" : "s"}.\n` +
        `\`BUILD.md\` is written for a coding agent${stack ? ` targeting **${stack}**` : ""}: drop it and the HTML into Claude Code, Codex or Grok and say "build this".`,
    );
    return true;
  }

  async statusText(projectId: string): Promise<string | undefined> {
    const p = await this.store.load(projectId);
    if (!p) return undefined;
    const cur = currentVersion(p);
    const L = [`**${p.brief}** — ${p.status}, ${p.versions.length} versions, ${p.decisions.length} decisions, ${p.constraints.length} constraints.`];
    if (cur) L.push(`Current: ${cur.id} — ${cur.summary} (${cur.approvals.length}/${Object.keys(p.participants).length} approved) ${cur.previewUrl}`);
    if (p.fork && !p.fork.resolved) {
      const a = Object.values(p.fork.votes).filter((v) => v === "a").length;
      const b = Object.values(p.fork.votes).filter((v) => v === "b").length;
      L.push(`Open vote: ${p.fork.question} — A ${a} · B ${b}`);
    }
    const people = Object.values(p.participants).map((x) => `${x.name} (${x.role ?? "no role"})`);
    L.push(`People: ${people.join(", ")}`);
    L.push(`Live canvas: ${this.liveUrl(p)}`);
    return L.join("\n");
  }

  // ---------------------------------------------------------------- timers

  private scheduleNudge(projectId: string, v: Version): void {
    this.cancelNudge(projectId);
    if (this.cfg.nudgeMinutes <= 0) return;
    this.nudgeTimers.set(
      projectId,
      setTimeout(() => void this.fireNudge(projectId, v.id), this.cfg.nudgeMinutes * 60_000),
    );
  }

  private cancelNudge(projectId: string): void {
    const t = this.nudgeTimers.get(projectId);
    if (t) clearTimeout(t);
    this.nudgeTimers.delete(projectId);
  }

  private async fireNudge(projectId: string, versionId: string): Promise<void> {
    this.nudgeTimers.delete(projectId);
    const p = await this.store.load(projectId);
    if (!p || p.status !== "active" || p.currentVersionId !== versionId || p.nudgedFor === versionId) return;
    if (p.fork && !p.fork.resolved) return; // the vote timer owns nudging while a fork is open
    if (this.store.isWorking(p.id)) {
      // A turn is in flight; check again shortly rather than talking over it.
      this.nudgeTimers.set(projectId, setTimeout(() => void this.fireNudge(projectId, versionId), 30_000));
      return;
    }
    const v = currentVersion(p);
    if (!v) return;
    const spokeSince = new Set(p.transcript.filter((t) => t.kind === "human" && t.at > v.createdAt).map((t) => t.userId));
    const silent = Object.values(p.participants).filter((x) => !spokeSince.has(x.id) && !v.approvals.includes(x.id));
    if (!silent.length) return;
    const open = p.questions.filter((q) => !q.answered).slice(-1)[0];
    const ask = open ? `Open question for ${open.to}: ${open.text}` : `Does ${v.id} work for you? Reply here or hit ✅ Approve.`;
    p.nudgedFor = versionId;
    await this.store.save(p);
    await this.surface.postText(p, `⏰ Still waiting on ${silent.map((x) => this.surface.mention(x.id, p)).join(", ")}. ${ask}`);
  }

  private scheduleForkTimeout(projectId: string, f: Fork): void {
    this.cancelForkTimeout(projectId);
    if (this.cfg.forkTimeoutMinutes <= 0) return;
    this.forkTimers.set(
      projectId,
      setTimeout(() => void this.fireForkTimeout(projectId, f.id), this.cfg.forkTimeoutMinutes * 60_000),
    );
  }

  private cancelForkTimeout(projectId: string): void {
    const t = this.forkTimers.get(projectId);
    if (t) clearTimeout(t);
    this.forkTimers.delete(projectId);
  }

  private async fireForkTimeout(projectId: string, forkId: string): Promise<void> {
    this.forkTimers.delete(projectId);
    const p = await this.store.load(projectId);
    const f = p?.fork;
    if (!p || !f || f.id !== forkId || f.resolved) return;
    if (Object.keys(f.votes).length > 0) {
      await this.surface.postText(p, `⏳ Closing the vote on "${f.question}" with the votes in so far.`);
      await this.resolveFork(projectId, forkId, "timeout");
    } else {
      const ids = Object.keys(p.participants);
      await this.surface.postText(p, `🗳️ No votes yet on "${f.question}". ${ids.map((id) => this.surface.mention(id, p)).join(", ")} — tap A or B above, or ⚖️ Resolve to let the role rule decide.`);
      this.scheduleForkTimeout(projectId, f); // one more window
    }
  }
}
