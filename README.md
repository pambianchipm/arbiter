# Arbiter

**A design agent that lives in your team's Discord thread.** Drop a brief (or a photo of a whiteboard), get a live prototype in the thread in under a minute, and then iterate *as a group*: the PM, the designer and the engineers all give feedback in the same thread, and Arbiter builds, arbitrates, and keeps the decision log.

The part a chatbox can't do: when two people ask for incompatible things, Arbiter doesn't pick. It **forks A/B, renders both side by side, opens a vote, and builds the winner** — then logs who asked for what and why, so `/handoff` produces a spec with full provenance.

```
#design  ·  @Arbiter landing page for a coffee subscription   [whiteboard.jpg]
  └─ 🎨 landing page for a coffee subscription
       Arbiter   📐 v1 — Hero + three value props            [screenshot] [✅ Approve] [✏️ Feedback] [📦 Handoff]
       Arbiter   ❓ @Sam — I went warm amber on stone. Is that the palette you had in mind?
       Sam       way more whitespace in the hero
       Priya     denser — and put social proof above the fold
       Arbiter   Conflict: Sam wants air, Priya wants density. Forking.
       Arbiter   🔀 Airy hero or denser hero with social proof?   [A | B side by side]  [🅰 Vote A] [🅱 Vote B] [⚖️ Resolve]
       Lee       fyi we don't have a carousel component
       Arbiter   📐 v3 — Airy hero (A won 2–1) · constraint logged: no carousel
       …
       /handoff  → handoff.md (decisions with provenance) + v3.html + v3.png
```

## How it works

```
Discord thread ──messages/buttons──▶ Orchestrator ──turn──▶ Claude (tool loop)
      ▲                               │ per-thread queue        │ publish_version · fork_variants · ask
      │                               │ 6s batching             │ log_decision · add_constraint · study_reference
      │                               │ nudge + vote timers      │ set_style · say
      └────── screenshots/embeds ◀── Surface ◀── tools ◀───────┘
                                        │
                              Preview server (Express) + Playwright
                              /p/<thread>/<version>   /p/<thread>/compare/<a>/<b>
```

- **One thread = one project.** State lives in `data/projects/<threadId>/state.json` plus one HTML and PNG per version. Restart-safe; the thread keeps working.
- **Turns are rebuilt from state**, not from a growing chat history, so context stays bounded however long the thread runs. The prompt carries the brief, constraints, style notes, decision log, the current HTML, and the transcript with NEW messages marked and attributed by name and role.
- **Batching.** Messages that land within `DEBOUNCE_MS` become one turn, so a disagreement arrives as a pair and the agent sees the conflict instead of chasing the first message.
- **Hard gates in code, not just prompt.** `publish_version` is refused while a vote is open. Renders that throw JS errors are bounced back to the model once before anything is posted. Tool failures return `is_error` so the model can recover.
- **Votes** auto-resolve when everyone in the thread has voted, on ⚖️ Resolve, or after `FORK_TIMEOUT_MINUTES` with at least one vote. Ties go to the role rule (visual → designer, content → pm, feasibility → eng) and the agent says which rule it applied.
- **Proactive.** After each version the agent asks at most two pointed questions to the people most likely to have an opinion. If nobody replies for `NUDGE_MINUTES`, it nudges the silent stakeholders once.
- **Roles** come from `/role`, or automatically from Discord roles named like *designer / product / pm / eng / dev*.
- **Reference sites.** "make it feel like https://linear.app" → the agent screenshots the site, extracts palette/type/spacing, and persists style notes for every later version.
- **Handoff** is deterministic (no model call): decisions with who/why/when, constraints, how each disagreement was settled and who voted how, style notes, open questions, version history, plus the final HTML and PNG.

## Live canvas (the "agent shares its screen" mode)

Every session posts a link like `http://localhost:3939/live/<thread>`. It's one page that always shows the latest state: the current version in an iframe, a pulsing "Arbiter is working…" badge during a turn, and during a vote it splits into A | B with the live tally. It updates over server-sent events the moment state changes.

For a voice/video session: hop in a Discord voice channel, and whoever runs the bot screen-shares that tab. Feedback goes in the thread (or, next step, by voice); the shared screen changes live. No public URL needed for this, since the screen-sharer's own localhost is what everyone sees.

## Brand memory: the second page is on-brand before anyone speaks

Each server has a brand (more by name with `/brand new`). When a page is approved by everyone, Arbiter lifts its `<head>` extras, `<header>` and `<footer>` into the brand along with the style tokens, constraints, and who's who, and adds the page to the site map. The next `/design` on that server starts from the brand: same chrome verbatim, a nav link added for the new page, links to the existing pages, brand rules honoured. Anything the team says should hold on every page ("the CTA is always rust") the agent records with `remember_for_brand`.

- `/brand show` — tokens, shared chrome, rules, people, and the site map with stable links.
- `/brand new <name>` · `/brand use <name>` — several products on one server.
- `/design … brand:<name>` — pick a brand for a session; otherwise the last-used one.
- `/p/<thread>/current` always serves a thread's latest version, so cross-page nav links don't go stale.

## Voice: talk to it in a voice channel

Join a voice channel, then in the design thread run `/voice join`. Arbiter joins, and from then on every utterance in that channel is transcribed and posted into the thread as `🎙️ Name: …`, attributed to whoever said it (Discord gives the bot a separate audio stream per speaker, so attribution is free), and handled exactly like a typed message: same batching, same conflict detection, same votes. Its questions and closing lines are spoken back. Keep the live canvas on a shared screen and it's a design review with the agent in the room.

Needs `ELEVENLABS_API_KEY` (speech-to-text via Scribe, speech via TTS) or `OPENAI_API_KEY` (Whisper, listen-only), and the bot invited with **Connect** and **Speak**. `/voice leave` stops it.

It is deliberately hard to trigger by accident. Utterances are cut on ~0.9s of silence; anything under a second or quieter than mic noise is dropped. In **listen** mode (default) a fast, cheap model decides whether each line is feedback, a request, a decision, or an answer, and skips greetings, filler, and side conversation. Skipped lines appear small in the thread so you can see what was filtered. In **address** mode (`/voice join mode:address` or `/voice mode address`) it acts only on lines that say its name: "Arbiter, make the hero denser." Spoken feedback batches for 12 seconds so a whole exchange becomes one turn. Tune with `VOICE_*` in `.env`. To stop: `/voice leave`, say "Arbiter, leave", or just leave the channel; it goes when the last human does.

## Hand off to a coding agent

`/handoff [stack]` (or the 📦 button) posts four files: `handoff-<thread>.md` (the full decision log with timestamps and votes), `BUILD.md` (a prompt-shaped brief for a coding agent: goal, non-negotiables, decisions to preserve, settled disagreements, style tokens, an acceptance checklist, and who to ask), plus the final `vN.html` and `vN.png`. Drop `BUILD.md` and the HTML into Claude Code, Codex or Grok and say "build this". Pass a stack, e.g. `/handoff stack: Next.js + Tailwind + shadcn`, to target it.

## Setup (10 minutes)

### 1. Discord application
1. https://discord.com/developers/applications → **New Application** → name it *Arbiter*.
2. **Bot** → Reset Token → copy it (`DISCORD_TOKEN`). Under *Privileged Gateway Intents* enable **Message Content Intent**.
3. **General Information** → copy the Application ID (`DISCORD_CLIENT_ID`).
4. **OAuth2 → URL Generator**: scopes `bot` + `applications.commands`; bot permissions *View Channels, Send Messages, Create Public Threads, Send Messages in Threads, Embed Links, Attach Files, Read Message History, Add Reactions, Use Slash Commands*, plus *Connect* and *Speak* for voice. Open the URL and add the bot to your server.
5. Right-click your server → Copy Server ID (`DISCORD_GUILD_ID`). With this set, slash commands appear instantly.

### 2. Run
```bash
npm install                # also installs Playwright's Chromium
cp .env.example .env       # fill in DISCORD_*, ANTHROPIC_API_KEY
npm run dev
```
Then in any channel: `/design brief: landing page for a coffee subscription` (optionally attach a sketch, add a reference URL), or just `@Arbiter <brief>` with a photo attached.

### 3. Public preview links (optional)
Screenshots post inline regardless. For clickable live links, expose the preview server and set `PUBLIC_BASE_URL`:
```bash
ngrok http 3939            # or: cloudflared tunnel --url http://localhost:3939
PUBLIC_BASE_URL=https://xyz.ngrok.app npm run dev
```

## Installing it on a server (yours or someone else's)

Nobody points Arbiter at a GitHub repo or a laptop. It is a bot process plus a small web server; it has to be running somewhere, and people add it to a Discord server with the OAuth invite link from step 4 above. One running instance serves any number of servers: roles are stored per guild, projects per thread.

- **Hackathon / demo:** run it on your laptop with `npm run dev`. Add `ngrok`/`cloudflared` only if you want clickable live links for people not looking at your screen.
- **Always-on:** any Node 20+ host with a persistent disk for `data/` (Railway, Fly.io, a $5 VPS). Set `PUBLIC_BASE_URL` to the host's URL so links in Discord work. Leave `DISCORD_GUILD_ID` empty to register commands globally.

## Commands and controls

| Where | What |
|---|---|
| `/design brief [sketch] [reference]` | Start a session in a new thread. |
| `@Arbiter <brief>` + image | Same, from a plain message. |
| `/role designer\|pm\|eng\|stakeholder` | Tell Arbiter your role (routing + tiebreaks). |
| `/constraint <text>` | Hard constraint every future version must respect. |
| `/status` · `/handoff [stack]` | Where things stand · post the spec, BUILD.md and source. |
| `/voice join` · `/voice leave` | Listen in your voice channel; every utterance becomes attributed feedback. |
| `/brand show` · `/brand new` · `/brand use` | The server's design memory and site map. |
| Any message in the thread | Feedback. Attach an annotated screenshot if you like. |
| ✅ Approve · ✏️ Feedback · 📦 Handoff | Buttons on every version. Everyone approving = shipped. |
| 🅰 🅱 ⚖️ | Vote on a fork, or resolve with the votes in so far. |

## Configuration

See `.env.example`. Notable:

- `ARBITER_MODEL` (default `claude-opus-5`), `ARBITER_EFFORT` (default `medium`; raise for quality, lower for speed).
- `ARBITER_FAST_MODE=1` uses Opus fast mode for a snappier live demo (premium pricing).
- `ARBITER_FALLBACKS=0` disables server-side refusal fallbacks if your org's API doesn't accept the beta.
- `DEBOUNCE_MS`, `NUDGE_MINUTES`, `FORK_TIMEOUT_MINUTES` tune the group dynamics.

## Develop without Discord

```bash
npm run smoke     # end-to-end with a scripted fake model: renderer, votes, gates, handoff (no API key needed)
npm run dry -- "landing page for a coffee subscription"   # real Claude, console thread; type  sam(designer): more whitespace
npm run typecheck
```

## Layout

```
src/
  index.ts             boot: store, preview server, browser, Claude, Discord
  orchestrator.ts      per-thread queue, batching, votes, approvals, nudges, handoff
  agent/prompts.ts     system prompt (cached) + per-turn context builder
  agent/tools.ts       tool schemas + executors (publish, fork, ask, decisions, constraints, reference, style, say)
  agent/run.ts         Claude tool loop with typed error handling
  discord/bot.ts       events → orchestrator; commands, buttons, modals; image intake; role inference
  discord/surface.ts   how the agent posts into Discord (embeds, attachments, tallies)
  discord/ui.ts        embeds / buttons / modal builders
  voice/manager.ts     per-thread voice session: per-speaker capture, transcription, spoken replies
  voice/stt.ts         ElevenLabs Scribe / OpenAI Whisper
  voice/tts.ts         ElevenLabs streaming TTS
  voice/audio.ts       48k stereo PCM → 16k mono WAV, hallucination filter
  render/server.ts     Express preview + A|B compare page
  render/screenshot.ts shared headless Chromium, error capture, bounded waits
  store.ts             atomic JSON + files per project
  handoff.ts           deterministic spec generator
  brand.ts             chrome extraction, absorbing shipped pages into brand memory
scripts/               smoke test, dry-run REPL, console surface
```
