# Making Arbiter something people can buy

Written 16 Sep 2026. The bot works end to end on one laptop. This is the path from there to a
product a stranger can add to their server and pay for. Estimated: one focused week for a sellable
v1, a second week for cost and polish.

## 1. What "sellable" means here

- A stranger clicks **Add to Discord**, types `/design`, and gets a prototype without talking to us.
- It runs 24/7 somewhere that isn't a laptop, survives restarts, and doesn't fall over when two
  servers use it at once.
- Usage is metered in a unit people understand, and there is a way to pay.
- Discord's verification requirements are met before we hit their thresholds.
- Nobody can use it to hurt us (cost blowups, server-side request forgery, data leaks).

## 2. Hosting (day 1–2)

- One always-on Node process serves every server; that is already how the bot works. Playwright and
  ffmpeg need a real box, not serverless: a 2 vCPU / 4 GB VPS (Hetzner, Fly.io machine, Railway) is
  plenty for dozens of servers.
- Domain + TLS in front of the preview server (Caddy is a two-line config). Set `PUBLIC_BASE_URL`
  so live links and the canvas work for people who aren't on the host machine.
- Persist `./data` on a volume now; move to Postgres or SQLite when there is a second instance or a
  second person on the team. The `Store` class is the only thing that touches disk.
- Process supervision (systemd or the platform's restart policy), structured logs (pino), and error
  alerts (Sentry, or Resend email which Phin already has). `/health` exists.
- A global render semaphore (2–3 concurrent Chromium contexts) on top of the existing one-turn-per-thread rule.

## 3. Hardening for strangers (day 2)

- **SSRF**: `study_reference` screenshots arbitrary URLs. On a hosted box that can reach localhost
  and cloud metadata. Block private ranges, localhost, and non-http(s) before navigating.
- **Unguessable preview URLs**: add a per-project token to `/p/<thread>-<token>/…` and the canvas.
  Thread ids are snowflakes, but not secrets.
- **Caps per server**: one running turn, N renders/day by plan, max HTML size, max images per message.
- **Retention**: delete project data after 30 days unless the server is on a paid plan; `/forget` to
  wipe a thread on demand. Say this in the privacy policy.
- **Voice consent**: the join message already states that the channel is transcribed. Keep it.

## 4. Metering and plans (day 3)

The unit is a **render**: one `publish_version` or one fork variant. It maps to cost, to value, and
to something people see in the thread. Decrement inside the tool executors; when a server is out,
the tool returns an error and the agent says "out of renders, `/plan` to top up." That is the
natural, visible metering point and needs no separate accounting code path.

| Plan | Price | Includes |
|---|---|---|
| Free | $0 | 3 renders / month, one brand, no voice |
| Team | ~$12 / month | 40 renders, brands, voice, priority model |
| Render pack | ~$5 | +20 renders, never expire |
| Bring your own key | ~$5 / month | unlimited renders on their Anthropic key |

Cost side (see the session estimate in BRIEFING): ~$0.30–0.50 per render on Opus, under $0.15 on
Sonnet with caching. Team at 40 renders costs us $6–20 on Opus, $2–6 on Sonnet. Run edits on Sonnet,
kickoffs and forks on Opus, and the plan clears comfortably.

Per-server record (`guilds/<id>.json` now, a table later): plan, renders remaining, renewal date,
Stripe customer id, BYOK key (encrypted at rest), default brand. New commands: `/plan` (usage +
upgrade link), `/setup key:` (BYOK, ephemeral reply, key never echoed).

## 5. Payments (day 4)

Stripe, which Phin already runs for Clinkworthy. Pattern used by every paid Discord bot:
`/plan` posts a link to `https://<domain>/upgrade?guild=<id>` → Stripe Checkout (subscription for
Team, one-time for packs) → webhook updates the server record → the bot confirms in the thread.
Discord's own App Subscriptions are an alternative later; they need verification and take a cut.

## 6. Discord's gates (start day 5, they take time)

- **Verification at 75 servers**: identity check, privacy policy URL, terms URL, a description of
  what the bot does. Write the two documents now; they are short.
- **Message Content intent approval at 100 servers**: we need it to read replies in design threads.
  The justification is specific and reasonable ("reads messages only in threads it created, to act
  on design feedback"). Apply as soon as verification is done; approvals take days to weeks.
- Bot listing: top.gg and discord.bots.gg once verified. Use Arbiter's own fork-and-vote demo GIF.

## 7. Onboarding

Landing page with **Add to Discord** (make it with Arbiter, that's the demo). After the bot joins,
post one message in the system channel: "Type `/design <what you're building>` in any channel."
Free tier without a card. The `/plan` nudge appears the first time a server runs out.

## 8. Cost work (week 2, roadmap item 1)

Cache the message history within a turn (cache breakpoint on the last user message so iterations
2–6 read the prefix at a tenth of the price), Sonnet 5 for edit turns, `effort=low` for turns with
no change request, `max_tokens` lower on edits. Measure with `response.usage` before and after.

## 9. Who buys, and how to find them

Teams that already live in Discord and ship UI: indie game studios, open-source projects,
crypto/web3 teams, small agencies, hackathon teams, Discord-native startups. Slack unlocks the
typical B2B team later; the orchestrator is platform-agnostic and a Slack `Surface` is a few days.

First ten customers by hand: post the fork demo video, offer a founding price, onboard them on a
call, weekly feedback like the Player2 design-partner playbook. Charge from day one.

## Already built (16 Sep)

Render metering in the tools with monthly reset, `/plan`, bring-your-own-key via `/setup` with
AES-256-GCM at rest, tokened preview and canvas URLs, hidden session index behind `ADMIN_TOKEN`,
private-address guard on `study_reference`, `/forget`, a render concurrency cap, and `/privacy` +
`/terms` served from `docs/legal`. All behind env flags; see README "Running it as a product".
Remaining from the list: hosting itself, Stripe checkout + webhook, retention job, the DB move.

## 10. Order of work

1. Hosting, domain, SSRF guard, URL tokens, render semaphore, supervision, logs. (2 days)
2. Per-server record, render metering in the tools, `/plan`, `/setup` for BYOK. (1 day)
3. Stripe Checkout + webhooks + upgrade page, free tier. (1 day)
4. Privacy policy, terms, portal application, landing page, listings. (1 day)
5. Cost work, Sentry, DB migration, first design partners. (week 2)
