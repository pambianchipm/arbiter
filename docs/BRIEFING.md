# Arbiter — briefing for the next Claude session

Written 15 Sep 2026 at the end of the build sessions. `CLAUDE.md` is the manual; this is the story,
the state, and what to do next.

## Where we are

Arbiter is live and working end to end in Phin's Discord server ("Hackathon Arbiter UI Bot Server
Testing"), running from his laptop with `npm run dev`. Everything below has been exercised with the
real model in a real thread unless marked otherwise.

**Proven live in Discord**
- `/design` with a brand reference URL → v1 in about a minute, styled from the reference, with
  role-routed questions.
- Feedback → v2, v3, including a working cart/checkout because someone asked.
- Approve → "shipped"; 📦 Handoff; `/brand show`; second page inheriting header/footer.
- Voice: `/voice join`, per-speaker transcription posted as `🎙️ Name: …`, spoken replies.
- The fork: proven with the real model in the dry run (two people, contradictory asks → conflict →
  A/B side by side → vote → winner built). Not yet demonstrated with two humans in Discord.

**Tested only by the smoke test (fake model, real renderer)**
- Vote auto-resolve on full turnout, tie → role rule, fork timeout, nudges, restart safety, zip
  handoff contents, brand absorb + inheritance, overflow bounce, title check.

**Built, never exercised**
- Whiteboard/photo intake via `/design sketch:` or an image on `@Arbiter <brief>`.
- Address mode and the relevance gate in a real noisy room (shipped after Phin's report that the
  bot reacted to everything; not yet confirmed by him).

**Landed 17 Sep (sandbox, smoke-tested, not yet run live)**
- Hosted-mode fixes: renders work behind `PUBLIC_BASE_URL`, bring-your-own-key clients stay per turn,
  bounced renders are refunded, reference sites are checked hop by hop (redirects, iframes), site-map
  links keep `?k=`, preview tokens are random, `/plan` applies the monthly reset.
- Cost: two cache breakpoints per request, `ARBITER_EDIT_MODEL` (Sonnet 5) for one person's feedback on
  an existing page, Opus-only betas keyed on the model, token usage on `/status` and the terminal.
- To verify on the laptop: `git pull`, stop and start the bot (new env var), run a session, then
  `/status`. The `Last turn` line should show tokens from cache on any turn with two or more steps.

## What we learned about the product

- The conflict moment is the demo. Judges will call it "Lovable in Discord" unless they see two
  people disagree and the agent fork instead of choosing.
- Attribution is free in Discord: text messages carry authors, voice carries per-speaker streams.
  That is the honest answer to "why this environment".
- The model behaves well with clear rules: it names people, explains tradeoffs, and asks the right
  role. It over-talks on non-change messages and re-asks questions unless told not to (prompt rules
  9–12 exist for this).
- Cost per session on Opus 5 is roughly $3, dominated by output HTML. Sonnet + caching brings it
  near $0.70. Flat unlimited pricing does not work on Opus; base fee + render credits does.
- Brand memory is what turns "landing page tool" into "your team's designer." It exists now: on
  ship, header/footer/head extras, tokens, constraints, people, and a site-map entry fold into
  the server's brand; the next `/design` starts from it.

## Demo plan (from docs/PITCH.md, condensed)

1. `/design brief: … make it feel like https://linear.app` with a whiteboard photo attached.
2. v1 lands; questions route to designer and PM (give teammates Discord roles named designer /
   product / eng beforehand, or `/role`).
3. Two people type contradictory asks within a few seconds → "Conflict … forking" → A|B → votes →
   winner built. This needs two accounts; rehearse once.
4. `/voice join mode:address` in a voice channel; "Arbiter, make the hero denser." Canvas at
   `localhost:3939/live/<thread>` on a shared screen. Say "Arbiter, leave" to end.
5. `/design pricing page` → on-brand v1 with the same chrome and a nav link back.
6. 📦 Handoff → one zip; open it in Claude Code and say "build this".

Set `ARBITER_FAST_MODE=1` for the demo. Flip the GitHub repo public before submission. If venue
Wi-Fi blocks UDP, voice needs a phone hotspot.

## Known rough edges

- Turn latency: 50–70s for a page on Opus at medium effort; forks ~60–90s. Fast mode helps.
- The live canvas iframe shows the page at the pane's width; pages are checked for sideways scroll
  at 1280px and 390px but not at arbitrary widths.
- Nudge/fork timers are in-memory; a restart forgets pending nudges (state itself survives).
- The cost work has not been measured on a real session. Compare the `turn done` token lines against
  the ~$3 per session estimate; if Sonnet edit turns over-talk or re-ask, that is a prompt fix, not a
  reason to switch back.
- The voice relevance gate fails open; if Haiku is unreachable every line counts.
- ElevenLabs Scribe request shape (`model_id=scribe_v1`, multipart `file`) worked on Phin's key;
  if their API changes, `stt failed:` lines in the terminal show the response.

## How we worked

Phin at a hackathon, me in a remote sandbox with no Discord token and no API key. So: the smoke
test carries everything the sandbox can verify; Phin runs the live parts and pastes terminal
output or screenshots; I fix and push to `main`; `tsx watch` restarts the bot on pull. Every
bug he hit became a self-explaining error in the product (port in use, no API key, missing
intent, missing permission, wrong page captured), plus a smoke assertion. Keep doing that:
when a failure is only visible in the terminal, surface it where he is looking.

## Next actions, in order

1. Confirm the noise fixes in a real call (`/voice join mode:address`), tune `VOICE_*` if needed.
2. Rehearse the two-person fork in Discord once.
3. Measure the cost work on one full session (`/status` after each turn) and watch Sonnet's edit turns
   for quality.
4. Hosting: a box, a domain, `PUBLIC_BASE_URL`, `PREVIEW_TOKENS`, `ARBITER_SECRET`, `METERING=1`. Then
   Stripe checkout + webhook, the retention job, the DB move (docs/PRODUCT.md).
5. Slack surface if a second environment is wanted for the pitch; the orchestrator is ready for it.
