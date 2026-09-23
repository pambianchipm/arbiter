# Arbiter — instructions for Claude working in this repo

Read this first. It is the operating manual for the codebase plus everything we learned
getting it live. `docs/BRIEFING.md` is the narrative handoff (state, decisions, demo plan).

## What Arbiter is

A design agent that lives in a team's Discord thread. `/design <brief>` opens a thread, the
agent builds a single-file HTML prototype, screenshots it, and posts it with Approve /
Feedback / Handoff buttons. Everyone in the thread gives feedback; the agent attributes each
ask to a named person with a role. When two people ask for incompatible things it does not
pick: it forks A/B, renders both side by side, opens a vote, builds the winner, and logs the
decision with provenance. It can listen in a voice channel, remembers the server's brand
across threads, and hands off a zip written for a coding agent.

The thesis: **the environment is the feature.** Several stakeholders already talking is what
makes conflict detection, votes, per-speaker attribution, and provenance possible. Never let a
change turn this into a one-user chatbot with a Discord skin.

Owner: Phin (`pambianchipm`). Built for a hackathon on 12–15 Sep 2026; being productized.

## Run it

```bash
npm install                 # also downloads Playwright Chromium and ffmpeg (~200MB)
cp .env.example .env        # ANTHROPIC_API_KEY, DISCORD_TOKEN/CLIENT_ID/GUILD_ID, optional ELEVENLABS_API_KEY
npm run dev                 # bot + preview server (tsx watch)
npm run dry -- "brief"      # real model, console thread, no Discord. Best way to iterate on the prompt.
npm run smoke               # end-to-end with a scripted fake model: renderer, votes, gates, brand, zip. No API key.
npm run typecheck
npm run build && npm run start:prod   # the compiled build production runs (Dockerfile does this)
```

Production runs on Railway from the `Dockerfile` with a volume at `/data`; the full go-live runbook
(Railway, Stripe dashboard, Discord portal, test purchase) is `docs/GO-LIVE.md`. Billing is on only
when all `STRIPE_*` variables and `ARBITER_SECRET` are set; metering only with `METERING=1`.

`tsx watch` restarts on file changes but **not** on new dependencies or gateway-intent changes:
after `npm install` or touching `createDiscordClient()`, stop and start the bot by hand.

Data lives in `./data` (git-ignored): `projects/<threadId>/{state.json, vN.html, vN.png}`,
`brands/<guildId>/<brandId>.json`, `roles/<guildId>.json`. Delete a project folder to forget it.

## Map

```
src/index.ts              boot order: store → preview server → browser → Claude → Discord client → surface → voice → orchestrator
src/orchestrator.ts       the hub: per-thread queue, message batching, votes, approvals, nudges, brand absorb, handoff, voice hooks
src/agent/prompts.ts      SYSTEM_PROMPT (byte-stable, cached) + buildTurnContent (per-turn context from state)
src/agent/tools.ts        tool schemas + executors: publish_version, fork_variants, ask, log_decision, add_constraint,
                          study_reference, set_style, say, post_handoff, remember_for_brand
src/agent/run.ts          Claude tool loop (beta namespace), typed errors, auto-degrade if optional betas are rejected
src/surface.ts            the Surface interface: everything the agent needs from "the place it lives"
src/discord/{bot,surface,ui,commands,register,errors,people}.ts
src/render/server.ts      Express: /p/<thread>/<v>, /p/<thread>/current, /p/<thread>/compare/<a>/<b>, /live/<thread> (SSE), /live index
src/render/screenshot.ts  shared headless Chromium, error capture, bounded waits, title check, overflow check
src/store.ts              atomic JSON + files, per-project save serialization, change events, brands
src/brand.ts              chrome extraction and absorbing shipped pages into brand memory
src/handoff.ts            handoff.md, BUILD.md, brand.md, and the zip
src/voice/{manager,stt,tts,gate,audio}.ts   voice session per thread, ElevenLabs/OpenAI STT, ElevenLabs TTS, noise + relevance gates
src/billing.ts            Stripe checkout, portal, webhook; signed upgrade links (HMAC with ARBITER_SECRET)
src/web/pages.ts          landing (overridable by web/landing.html), upgrade, result pages
src/net.ts, src/crypto.ts private-address guard for study_reference; AES-256-GCM for bring-your-own keys
Dockerfile, railway.json  production image (Playwright base) and Railway config
scripts/smoke.ts          the test. scripts/dry.ts the REPL. scripts/console-surface.ts a Surface that prints.
docs/PITCH.md             judging map + demo script. docs/BRIEFING.md handoff narrative.
```

## How a turn works

One thread = one `Project` on disk. Every agent turn is **rebuilt from state**, not a growing
chat history: brief, participants with roles, constraints, style, decision log, open questions,
versions, open fork with tally, the last 40 transcript lines with NEW ones marked, the current
version's HTML, brand memory (chrome, tokens, rules, site map), and any images. The model then
runs a tool loop (max 8 iterations). Tools post to the Surface as they execute, so people see
progress mid-turn. The closing text is posted last.

Batching: messages within `DEBOUNCE_MS` (6s; 12s for voice) become one turn, so a disagreement
arrives as a pair. While a turn runs, new messages queue for the next one. One turn per thread.

## Hard rules

1. **Nothing is published while a fork is open.** Enforced in `publish_version`, not just prompted.
2. **The agent never picks a side.** Conflicts fork; ties use the role rule (visual → designer,
   content → pm, feasibility → eng) and say so. Keep this in the prompt.
3. **Humans control shipping.** Approve is a button; "shipped" means everyone approved. Handoff
   is a button, a command, or an explicit ask. No auto-anything that spends or publishes elsewhere.
4. **`SYSTEM_PROMPT` stays byte-stable between turns** (it is prompt-cached). Per-turn content goes in
   `buildTurnContent`. Tools are rendered before system in the cache prefix: don't reorder them casually.
5. **Renders are checked before they post**: page title must match the HTML's `<title>`, JS page
   errors bounce once, sideways scroll at 1280px bounces once, mobile overflow is a note.
6. **Secrets stay in `.env`.** Never print keys. Never commit `.env`. The bot must never echo a token.
7. **Smoke must pass before pushing.** `npm run smoke`. Add an assertion for anything you fix.
8. **Slash-command descriptions ≤ 100 chars.** Discord validates at import; the smoke test checks.
9. **Pure-JS voice deps only** (`opusscript`, not `@discordjs/opus`): Phin runs Node 25.
10. **Never run a local bot with the production token.** Local dev uses a separate "Arbiter Dev"
    application. Two processes on one token both answer everything. Railway runs exactly one replica.
11. **Billing is webhook-driven and idempotent.** Plan changes happen only in the `billing*` methods on
    the orchestrator, called from `src/billing.ts` after signature verification; each Stripe event id is
    applied once. Don't grant renders anywhere else.
12. **`ARBITER_SECRET` is permanent** once live: it encrypts saved keys and signs upgrade links.

## Model configuration

`claude-opus-5` by default (`ARBITER_MODEL`), `effort=medium` (`ARBITER_EFFORT`), adaptive thinking by
omission (do not add a `thinking` param, never `budget_tokens`). `ARBITER_FAST_MODE=1` enables Opus
fast mode for demos. Server-side refusal fallbacks are on by default via beta headers; if the API
returns a 400 for an optional beta the agent retries without them and stays degraded for the process.
The voice relevance gate uses `claude-haiku-4-5`. Everything goes through `client.beta.messages.stream`.
Prompt caching: system prompt has a cache breakpoint; message history is not yet cached (see Roadmap).

## How to add things

- **A tool**: add to `TOOL_DEFS`, a case in `executeTool`, an executor that mutates `ctx.project` and
  saves, a rule in `SYSTEM_PROMPT`, and a scripted call in `scripts/smoke.ts`.
- **A slash command**: `commands.ts` (≤100-char descriptions) + a case in `onCommand` in `bot.ts`.
  Defer or reply within 3 seconds, then do work; button handlers defer first.
- **Another chat platform**: implement `Surface` (see `scripts/console-surface.ts`), map its events to
  `orchestrator.startProject / addHumanMessage / vote / approve / handoff`. The agent does not know Discord.
- **Anything the model must never do**: enforce it in the tool executor, then also say it in the prompt.

## Things that bit us (don't rediscover these)

- Node's `server.listen` can emit `listening` and only then `EADDRINUSE`; `listen()` in `server.ts`
  verifies the socket after a 60ms settle. The dry run falls back to a free port. "Cannot GET /live"
  with a stale process on 3939 was this.
- Playwright: use `goto(waitUntil: "commit")` then bounded waits; a hanging `<script src>` in `<head>`
  blocks `domcontentloaded`. Iframes on the compare page need their own load waits.
- In sandboxed CI behind a TLS-intercepting proxy, set `ARBITER_BROWSER_PROXY` and
  `ARBITER_BROWSER_INSECURE_TLS=1` (never in production); localhost bypasses the proxy or the
  screenshot captures the proxy's error page. The title check catches that class of bug.
- Two concurrent saves of one project shared a temp filename → ENOENT on rename. Saves are now
  serialized per project with unique temp names.
- Discord: `GuildVoiceStates` intent is required to see who is in a voice channel and to complete a
  voice handshake. A voice channel with its own permission overrides can hide the channel from the bot
  even when the role has Connect server-wide. Portal permission tickboxes only change the invite URL;
  fix an existing bot via Server Settings → Roles or re-run the invite URL.
- Discord voice needs UDP; there is no TCP fallback. macOS firewall prompts for `node` the first time.
- Writing two full HTML documents in one `fork_variants` call can truncate; a side may `reuse_version`.
- On a hosted box the public URL isn't localhost: screenshots must go to the local listener
  (`localBase()` in tools.ts). An early version derived the port from the public URL and would have
  screenshotted port 80 in production; the smoke test now renders through a public base URL.
- The model re-asked open questions and posted three messages on "looks good" until the prompt rules
  9–11 were added. Keep them.
- ElevenLabs key needs Speech to Text and Text to Speech permissions. Discord's own voice activity
  detection already trims silence; the noise you hear is real speech fragments, hence the relevance gate.

## Working with Phin

He pushes to `main`, tests live on his laptop, and pastes terminal output or screenshots. Give
paste-and-go commands, say what to look for, and ask for the exact log line when you need it.
He is not watching the terminal unless told to; put diagnostics where he is looking (the thread,
the `/live` page). Plain words, no jargon, direct verdicts. When something is his environment
rather than the code (firewall, permissions, a stale process), say so plainly.

## Roadmap (agreed)

1. Prompt-cache the message history within a turn (cache breakpoint on the last user message) and
   run edit turns on Sonnet 5 with Opus for kickoff and forks: roughly halves cost per session.
2. Productize: base fee + render credits (one credit per version or fork variant), per-server settings
   and optional bring-your-own-key, usage counter, privacy policy + terms (Discord requires them past
   100 servers), state in a database instead of files.
3. Brand memory v2: people notes ("Sam consistently asks for more whitespace"), a model-written brand
   document on ship, site-level handoff from `/brand`.
4. Slack surface (implement `Surface`; the orchestrator is platform-agnostic).
5. Whiteboard-photo intake is built but only lightly tested; exercise it with real phone photos.
