# Arbiter — pitch notes

## One line
A design agent that lives in the team's Discord thread and does the thing a chatbox structurally cannot: arbitrate between people who disagree.

## Why Discord is not a wrapper
- A chatbox has one human. A design thread has a PM, a designer and engineers with conflicting wants. The agent's core value — detect the conflict, fork A/B, run the vote, build the winner, log provenance — only exists where several stakeholders already talk.
- Discord primitives map onto the workflow: **threads = projects**, **messages = attributed feedback**, **buttons = votes and approvals**, **modals = structured feedback**, **mentions = proactive routing to the right role**, **attachments = whiteboard photos in, screenshots out**.
- The thread *is* the spec. Every accepted change is logged with who asked and why; `/handoff` turns the conversation into an engineering document with a decision trail.

## Judging criteria map
| Criterion | What to show |
|---|---|
| Core requirements | `/design` → v1 in the thread in <60s; feedback → v2; vote → v3; `/handoff`. Fully functional, restart-safe. |
| Innovation | The conflict moment: two contradictory messages, "Conflict. Forking.", A/B side by side, vote buttons, winner built, role-rule tiebreak. |
| Technical execution | Claude tool loop with hard gates in code (no publish during a vote, JS-error renders bounced back), per-thread queue + batching, Playwright with error capture and bounded waits, atomic state, typed API error handling, deterministic handoff. Smoke test runs the whole loop with a fake model. |
| Usefulness | Replaces the designer↔PM↔eng ping-pong. Proactive, role-aware questions; nudges the silent; constraints from eng become law. Human control everywhere: approve, vote, resolve, constraint. |

## 3-minute demo script
1. **Kickoff (0:00)** In `#design`: `@Arbiter landing page for a coffee subscription` with a phone photo of a whiteboard sketch. Thread opens; "On it." Typing indicator.
2. **v1 (0:40)** Screenshot lands with Approve / Feedback / Handoff buttons. Arbiter @-mentions the designer with a palette question and the PM with a content question.
3. **Conflict (1:10)** Designer: "way more whitespace in the hero." PM, seconds later: "denser — social proof above the fold." Arbiter: "Conflict… Forking." Side-by-side A|B with vote buttons.
4. **Vote (1:50)** Three people tap. Tally updates live on the embed. Auto-resolves on the last vote. "A wins 2–1."
5. **Constraint (2:15)** Eng: "we don't have a carousel component." v3 posts with the winner and the constraint logged; Arbiter explains what it swapped.
6. **Handoff (2:40)** `/handoff` → markdown spec with decisions, who asked, why, how the vote went, plus the HTML. Everyone taps ✅ → "shipped".

## Second-page beat
After the landing page ships: `/design pricing page`. v1 arrives with the same header and footer, the palette, and a nav link back to the landing page, without anyone restating the brand. `/brand show` displays what the agent learned. Line for judges: the server is the memory; every thread starts where the last one ended.

## Voice beat (if the room has a voice channel)
`/voice join` in the thread. Talk. Each sentence lands in the thread as `🎙️ Name: …` and the canvas changes; Arbiter asks its question out loud. Attribution is per speaker because Discord streams each voice separately: this is the "environment makes the agent better" line in its purest form.

## Anticipated questions
- *"Isn't this Lovable in Discord?"* Lovable is one person. Arbiter's job is negotiation and provenance among several. Show the fork.
- *"Why not Slack?"* Same design works there; Discord's buttons/threads/modals made it faster to build and judges can join the server and try it live.
- *"What if it picks wrong?"* It never picks on a conflict; humans vote. Ties are settled by a stated rule and logged. Nothing ships without approvals.
- *"What about real code?"* Prototypes are single-file Tailwind HTML; the handoff maps 1:1 onto components. Next step is emitting a PR against the design system.

## Setup for the judges' table
- Have the bot running before judging with `ARBITER_FAST_MODE=1` and a tunnel for live links.
- Pre-assign Discord roles *designer / product / eng* to three teammates so questions route without `/role`.
- Keep a whiteboard photo on your phone. Keep a reference URL ready ("make it feel like linear.app").
- If Wi-Fi is bad: `npm run dry` shows the same loop in a terminal.
