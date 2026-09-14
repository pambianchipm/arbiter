import {
  AudioPlayerStatus,
  EndBehaviorType,
  StreamType,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  joinVoiceChannel,
  type AudioPlayer,
  type VoiceConnection,
} from "@discordjs/voice";
import prism from "prism-media";
import { PermissionFlagsBits, type Client, type VoiceBasedChannel } from "discord.js";
import type { Orchestrator } from "../orchestrator.js";
import type { Surface } from "../surface.js";
import type { SpeechToText } from "./stt.js";
import type { ElevenLabsTTS } from "./tts.js";
import { durationSeconds48kStereo, looksLikeHallucination, pcm48kStereoToWav16kMono } from "./audio.js";
import { inferRole } from "../discord/people.js";
import { log, errMsg } from "../log.js";

interface VoiceSession {
  projectId: string;
  guildId: string;
  channelId: string;
  channelName: string;
  connection: VoiceConnection;
  player: AudioPlayer;
  queue: string[];
  /** users with an utterance currently being captured */
  capturing: Set<string>;
  /** per-user transcription chains so one person's sentences post in order */
  chains: Map<string, Promise<void>>;
}

/**
 * One voice session per design thread. Discord gives a separate audio stream per speaker,
 * so every utterance is attributed for free. Utterances are cut on ~0.9s of silence,
 * transcribed, posted into the thread as "🎙️ Name: …" and fed into the same feedback path
 * as typed messages. The agent's questions and closing lines are spoken back.
 */
export class VoiceManager {
  private sessions = new Map<string, VoiceSession>();

  constructor(
    private readonly client: Client,
    private readonly orch: Orchestrator,
    private readonly surface: Surface,
    private readonly stt: SpeechToText | undefined,
    private readonly tts: ElevenLabsTTS | undefined,
  ) {}

  get sttName(): string | undefined {
    return this.stt?.name;
  }

  has(projectId: string): boolean {
    return this.sessions.has(projectId);
  }

  async join(projectId: string, channel: VoiceBasedChannel): Promise<string> {
    if (!this.stt) {
      throw new Error("No speech-to-text is configured. Set ELEVENLABS_API_KEY (Scribe) or OPENAI_API_KEY (Whisper) in .env and restart.");
    }
    await this.leave(projectId);

    // Fail with the exact missing permission instead of a 15s timeout.
    const me = channel.guild.members.me ?? (await channel.guild.members.fetchMe().catch(() => null));
    const perms = me ? channel.permissionsFor(me) : null;
    const need: [bigint, string][] = [
      [PermissionFlagsBits.ViewChannel, "View Channel"],
      [PermissionFlagsBits.Connect, "Connect"],
      [PermissionFlagsBits.Speak, "Speak"],
    ];
    const missing = perms ? need.filter(([bit]) => !perms.has(bit)).map(([, name]) => name) : [];
    if (missing.length) {
      throw new Error(`The bot is missing ${missing.join(" and ")} on #${channel.name}. Server Settings → Roles → Arbiter → Voice, or the channel's own permission overrides.`);
    }
    if (channel.userLimit && channel.members.size >= channel.userLimit && !channel.members.has(me?.id ?? "")) {
      throw new Error(`#${channel.name} is full (limit ${channel.userLimit}).`);
    }

    const connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: false,
    });
    connection.on("stateChange", (o, n) => log.info(`voice: ${o.status} → ${n.status}`));
    connection.on("error", (e) => log.warn("voice connection error:", errMsg(e)));
    if (process.env.VOICE_DEBUG === "1") connection.on("debug", (m) => log.info("voice debug:", m));
    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
    } catch {
      const stuck = connection.state.status;
      connection.destroy();
      const hint =
        stuck === VoiceConnectionStatus.Signalling
          ? "Discord never sent the voice server details (stuck in signalling). Usually the GuildVoiceStates intent is missing from the client or the bot lacks Connect."
          : stuck === VoiceConnectionStatus.Connecting
            ? "The UDP/encryption handshake did not finish (stuck in connecting). Check the terminal's voice dependency report for missing encryption/DAVE libraries, and that the network allows UDP."
            : `last state: ${stuck}`;
      throw new Error(`Could not connect to #${channel.name} within 20s. ${hint}`);
    }

    const player = createAudioPlayer();
    connection.subscribe(player);
    const session: VoiceSession = {
      projectId,
      guildId: channel.guild.id,
      channelId: channel.id,
      channelName: channel.name,
      connection,
      player,
      queue: [],
      capturing: new Set(),
      chains: new Map(),
    };
    this.sessions.set(projectId, session);

    connection.receiver.speaking.on("start", (userId) => this.onSpeakingStart(session, userId));
    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        // Discord moves/reconnects us: give it 5s to come back before treating it as a leave.
        await Promise.race([entersState(connection, VoiceConnectionStatus.Signalling, 5_000), entersState(connection, VoiceConnectionStatus.Connecting, 5_000)]);
      } catch {
        await this.leave(projectId, "the voice connection dropped");
      }
    });
    player.on(AudioPlayerStatus.Idle, () => void this.playNext(session));
    player.on("error", (e) => log.warn("voice player", errMsg(e)));

    await this.orch.setVoiceBinding(projectId, { channelId: channel.id, channelName: channel.name, since: new Date().toISOString() });
    log.info(`voice: joined #${channel.name} for ${projectId} (stt=${this.stt.name}, tts=${this.tts ? "on" : "off"})`);
    return `🎙️ Listening in **${channel.name}**. Everything said there is transcribed into this thread and attributed to whoever said it${this.tts ? ", and I'll answer out loud" : ""}. Keep the live canvas on a shared screen. \`/voice leave\` to stop.`;
  }

  private onSpeakingStart(session: VoiceSession, userId: string): void {
    if (userId === this.client.user?.id) return;
    if (session.capturing.has(userId)) return;
    session.capturing.add(userId);

    const opus = session.connection.receiver.subscribe(userId, { end: { behavior: EndBehaviorType.AfterSilence, duration: 900 } });
    const decoder = new prism.opus.Decoder({ rate: 48_000, channels: 2, frameSize: 960 });
    const chunks: Buffer[] = [];
    decoder.on("data", (c: Buffer) => chunks.push(c));
    const done = () => {
      if (!session.capturing.has(userId)) return;
      session.capturing.delete(userId);
      this.enqueue(session, userId, Buffer.concat(chunks));
    };
    decoder.once("end", done);
    decoder.once("close", done);
    decoder.once("error", (e) => {
      log.warn("opus decode", errMsg(e));
      session.capturing.delete(userId);
    });
    opus.once("error", (e) => {
      log.warn("voice receive", errMsg(e));
      session.capturing.delete(userId);
    });
    opus.pipe(decoder);
  }

  private enqueue(session: VoiceSession, userId: string, pcm: Buffer): void {
    const prev = session.chains.get(userId) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(() => this.transcribeAndPost(session, userId, pcm));
    session.chains.set(userId, next);
  }

  private async transcribeAndPost(session: VoiceSession, userId: string, pcm: Buffer): Promise<void> {
    if (!this.sessions.has(session.projectId)) return;
    const secs = durationSeconds48kStereo(pcm);
    if (secs < 0.6) return; // coughs, clicks
    const wav = pcm48kStereoToWav16kMono(pcm);
    const t0 = Date.now();
    let text: string;
    try {
      text = await this.stt!.transcribe(wav);
    } catch (e) {
      log.warn("stt failed:", errMsg(e));
      return;
    }
    if (!text || looksLikeHallucination(text)) return;

    const guild = this.client.guilds.cache.get(session.guildId);
    const member = await guild?.members.fetch(userId).catch(() => undefined);
    const name = member?.displayName ?? this.client.users.cache.get(userId)?.username ?? `user-${userId.slice(-4)}`;
    const p = await this.orch.get(session.projectId);
    if (!p) return;
    log.info(`🎙️ ${name} (${secs.toFixed(1)}s, stt ${Date.now() - t0}ms): ${text}`);
    await this.surface.postText(p, `🎙️ **${name}**: ${text}`);
    await this.orch.addHumanMessage(session.projectId, { userId, name, text, role: inferRole(member) });
  }

  /** Speak text in the bound channel (queued, never overlapping). No-op without TTS. */
  speak(projectId: string, text: string): void {
    const s = this.sessions.get(projectId);
    if (!s || !this.tts) return;
    const clean = text.replace(/<@!?\d+>/g, "").replace(/[*_`#>]/g, "").replace(/\s+/g, " ").trim();
    if (!clean) return;
    s.queue.push(clean.slice(0, 700));
    if (s.player.state.status === AudioPlayerStatus.Idle) void this.playNext(s);
  }

  private async playNext(s: VoiceSession): Promise<void> {
    const text = s.queue.shift();
    if (!text || !this.tts) return;
    try {
      const stream = await this.tts.stream(text);
      s.player.play(createAudioResource(stream, { inputType: StreamType.Arbitrary }));
    } catch (e) {
      log.warn("tts failed:", errMsg(e));
      void this.playNext(s);
    }
  }

  async leave(projectId: string, reason?: string): Promise<boolean> {
    const s = this.sessions.get(projectId);
    if (!s) return false;
    this.sessions.delete(projectId);
    s.player.stop(true);
    s.connection.destroy();
    await this.orch.setVoiceBinding(projectId, undefined);
    log.info(`voice: left #${s.channelName} for ${projectId}${reason ? ` (${reason})` : ""}`);
    if (reason) {
      const p = await this.orch.get(projectId);
      if (p) await this.surface.postText(p, `🎙️ Stopped listening: ${reason}. \`/voice join\` to resume.`).catch(() => undefined);
    }
    return true;
  }

  async destroyAll(): Promise<void> {
    for (const id of [...this.sessions.keys()]) await this.leave(id);
  }
}
