/**
 * Server-rendered pages for the hosted product: landing, upgrade, checkout result.
 * Self-contained HTML (no external assets besides one Google Font) so they load fast anywhere.
 * A file at web/landing.html replaces the built-in landing page (placeholders: {{INVITE_URL}} etc.),
 * so the landing page can be designed in Arbiter itself and dropped in.
 */
import { promises as fs } from "node:fs";

export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);

export interface SiteInfo {
  inviteUrl: string;
  contactEmail?: string;
  freeRenders: number;
  teamRenders: number;
  packRenders: number;
  teamPrice: string; // "$12 / month"
  packPrice: string; // "$5"
}

const CSS = `
:root{--bg:#0b0d12;--panel:#12151c;--line:#232835;--fg:#eef0f5;--dim:#9aa3b2;--blue:#3b82f6;--pink:#ec4899;--green:#22c55e;--r:16px}
*{box-sizing:border-box}html,body{margin:0;background:var(--bg);color:var(--fg);font-family:Inter,ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;-webkit-font-smoothing:antialiased}
a{color:inherit}.wrap{max-width:1080px;margin:0 auto;padding:0 20px;overflow-x:hidden}
nav{display:flex;align-items:center;justify-content:space-between;padding:20px 0}.logo{display:flex;align-items:center;gap:10px;font-weight:800;font-size:18px;text-decoration:none}
.mark{width:28px;height:28px;border-radius:8px;background:linear-gradient(135deg,var(--blue),var(--pink))}
.nav-links{display:flex;gap:22px;align-items:center;font-size:14px;color:var(--dim)}.nav-links a{text-decoration:none}
.btn{display:inline-flex;align-items:center;gap:8px;border-radius:999px;padding:12px 20px;font-weight:700;font-size:15px;text-decoration:none;border:1px solid transparent;cursor:pointer;font-family:inherit}
.btn.primary{background:#5865f2;color:#fff}.btn.primary:hover{background:#4752c4}.btn.ghost{border-color:var(--line);color:var(--fg);background:transparent}.btn.ghost:hover{border-color:#3a4152}
.btn.sm{padding:8px 14px;font-size:14px}
.hero{padding:64px 0 40px;display:grid;grid-template-columns:1.05fr .95fr;gap:48px;align-items:center}
.eyebrow{color:var(--pink);font-weight:700;font-size:13px;letter-spacing:.08em;text-transform:uppercase}
h1{font-size:clamp(36px,5vw,56px);line-height:1.05;letter-spacing:-.03em;margin:14px 0 18px}
.lede{color:var(--dim);font-size:18px;line-height:1.6;max-width:34em}.cta{display:flex;gap:12px;flex-wrap:wrap;margin-top:28px}.fine{color:var(--dim);font-size:13px;margin-top:14px}
.thread{background:var(--panel);border:1px solid var(--line);border-radius:var(--r);padding:18px;font-size:14px;line-height:1.5;position:relative;overflow:hidden}
.msg{display:grid;grid-template-columns:30px 1fr;gap:10px;padding:8px 0}.av{width:30px;height:30px;border-radius:50%}
.who{font-weight:700;font-size:13px}.who span{color:var(--dim);font-weight:500;margin-left:6px}
.ab{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:8px}.side{border-radius:10px;border:1px solid var(--line);padding:10px;background:#0e1117}
.side b{display:inline-grid;place-items:center;width:20px;height:20px;border-radius:6px;font-size:12px;margin-right:6px;color:#fff}.side.a b{background:var(--blue)}.side.b b{background:var(--pink)}
.mini{height:54px;border-radius:6px;margin-top:8px;background:linear-gradient(180deg,#1b2130,#141925)}.mini.dense{background:repeating-linear-gradient(180deg,#1b2130 0 8px,#141925 8px 14px)}
.votes{display:flex;gap:6px;margin-top:8px}.chip{font-size:12px;border:1px solid var(--line);border-radius:999px;padding:3px 9px;color:var(--dim)}
section{padding:56px 0;border-top:1px solid var(--line)}h2{font-size:30px;letter-spacing:-.02em;margin:0 0 8px}.sub{color:var(--dim);margin:0 0 28px;font-size:16px}
.steps{display:grid;grid-template-columns:repeat(4,1fr);gap:14px}.card{background:var(--panel);border:1px solid var(--line);border-radius:var(--r);padding:20px}
.card .n{color:var(--blue);font-weight:800;font-size:13px}.card h3{margin:8px 0 6px;font-size:17px}.card p{margin:0;color:var(--dim);font-size:14px;line-height:1.55}
.plans{display:grid;grid-template-columns:repeat(3,1fr);gap:14px}.plan{display:flex;flex-direction:column;gap:10px}.plan .price{font-size:30px;font-weight:800;letter-spacing:-.02em}.plan .price small{font-size:14px;color:var(--dim);font-weight:500}
.plan ul{margin:0;padding-left:18px;color:var(--dim);font-size:14px;line-height:1.7;flex:1}.plan.hot{border-color:var(--blue);box-shadow:0 0 0 1px var(--blue) inset}
.faq{display:grid;grid-template-columns:1fr 1fr;gap:14px}footer{padding:36px 0 48px;color:var(--dim);font-size:14px;display:flex;gap:18px;flex-wrap:wrap;border-top:1px solid var(--line)}
.center{max-width:640px;margin:0 auto;padding:64px 20px}.notice{border:1px solid var(--line);border-radius:12px;padding:14px 16px;color:var(--dim);background:var(--panel)}
form{margin:0}
@media (max-width:860px){.hero{grid-template-columns:1fr;padding-top:36px}.steps{grid-template-columns:1fr 1fr}.plans,.faq{grid-template-columns:1fr}.nav-links a:not(.btn){display:none}}
@media (max-width:480px){.steps{grid-template-columns:1fr}}
`;

function shell(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><meta name="description" content="Arbiter is a design agent that lives in your Discord. It builds live prototypes, forks A/B when your team disagrees, and hands off a spec your coding agent can build.">
<link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;700;800&display=swap" rel="stylesheet">
<style>${CSS}</style></head><body>${body}</body></html>`;
}

function nav(info: SiteInfo): string {
  return `<nav><a class="logo" href="/"><span class="mark"></span>Arbiter</a><div class="nav-links"><a href="/#how">How it works</a><a href="/#pricing">Pricing</a><a class="btn primary sm" href="${esc(info.inviteUrl)}">Add to Discord</a></div></nav>`;
}

function footer(info: SiteInfo): string {
  return `<footer><span>© ${new Date().getFullYear()} Arbiter</span><a href="/privacy">Privacy</a><a href="/terms">Terms</a>${info.contactEmail ? `<a href="mailto:${esc(info.contactEmail)}">${esc(info.contactEmail)}</a>` : ""}</footer>`;
}

export async function landingPage(info: SiteInfo, overrideFile = "web/landing.html"): Promise<string> {
  try {
    const custom = await fs.readFile(overrideFile, "utf8");
    const vars: Record<string, string> = {
      INVITE_URL: info.inviteUrl,
      CONTACT_EMAIL: info.contactEmail ?? "",
      FREE_RENDERS: String(info.freeRenders),
      TEAM_RENDERS: String(info.teamRenders),
      PACK_RENDERS: String(info.packRenders),
      PRICE_TEAM: info.teamPrice,
      PRICE_PACK: info.packPrice,
    };
    return custom.replace(/\{\{([A-Z_]+)\}\}/g, (m, k: string) => (k in vars ? esc(vars[k]) : m));
  } catch {
    /* no override: built-in page */
  }
  const av = (c: string) => `<div class="av" style="background:${c}"></div>`;
  return shell(
    "Arbiter — the design agent that settles the argument",
    `<div class="wrap">${nav(info)}
<div class="hero"><div>
  <div class="eyebrow">A design agent for Discord</div>
  <h1>Design with your whole team. Let the agent settle the argument.</h1>
  <p class="lede">Describe a page in a channel. Arbiter builds a live prototype in under a minute and iterates on everyone's feedback. When two people want opposite things, it builds both, side by side, and lets the team vote. Every decision is logged with who asked and why.</p>
  <div class="cta"><a class="btn primary" href="${esc(info.inviteUrl)}">Add to Discord</a><a class="btn ghost" href="#how">See how it works</a></div>
  <p class="fine">Free for ${info.freeRenders} renders a month. No card. Or bring your own Anthropic key for unlimited.</p>
</div>
<div class="thread" aria-label="Example Discord thread">
  <div class="msg">${av("#f59e0b")}<div><div class="who">Sam <span>designer</span></div>way more whitespace in the hero</div></div>
  <div class="msg">${av("#22c55e")}<div><div class="who">Priya <span>pm</span></div>denser, and put social proof above the fold</div></div>
  <div class="msg">${av("linear-gradient(135deg,#3b82f6,#ec4899)")}<div><div class="who">Arbiter <span>app</span></div>Conflict: Sam wants air, Priya wants proof up top. Building both.
    <div class="ab"><div class="side a"><b>A</b>Airy hero<div class="mini"></div></div><div class="side b"><b>B</b>Proof above fold<div class="mini dense"></div></div></div>
    <div class="votes"><span class="chip">🅰 2 votes</span><span class="chip">🅱 1 vote</span><span class="chip">⚖️ Resolve</span></div></div></div>
  <div class="msg">${av("linear-gradient(135deg,#3b82f6,#ec4899)")}<div><div class="who">Arbiter <span>app</span></div>A wins 2–1. v3 is up, decision logged. Lee, noted: no carousels.</div></div>
</div></div>
<section id="how"><h2>How it works</h2><p class="sub">Everything happens where your team already talks.</p>
<div class="steps">
  <div class="card"><div class="n">01</div><h3>Brief it</h3><p><code>/design</code> with a sentence, a whiteboard photo, or a site to borrow the feel from.</p></div>
  <div class="card"><div class="n">02</div><h3>Iterate together</h3><p>Everyone replies in the thread, or talks in voice. Arbiter attributes every ask and asks the right person the right question.</p></div>
  <div class="card"><div class="n">03</div><h3>Vote on conflicts</h3><p>Contradictory feedback becomes an A/B vote, not a coin flip. Ties go to a stated role rule.</p></div>
  <div class="card"><div class="n">04</div><h3>Hand off</h3><p>Approve, then get a zip with the page, the decision log, and a brief your coding agent can build from.</p></div>
</div></section>
<section id="pricing"><h2>Pricing</h2><p class="sub">A render is one generated version or one A/B variant.</p>
<div class="plans">
  <div class="card plan"><h3>Free</h3><div class="price">$0</div><ul><li>${info.freeRenders} renders a month</li><li>Votes, handoff, brand memory</li><li>No card required</li></ul><a class="btn ghost" href="${esc(info.inviteUrl)}">Add to Discord</a></div>
  <div class="card plan hot"><h3>Team</h3><div class="price">${esc(info.teamPrice)}</div><ul><li>${info.teamRenders} renders a month</li><li>Voice sessions</li><li>Render packs: ${info.packRenders} for ${esc(info.packPrice)}, never expire</li></ul><a class="btn primary" href="${esc(info.inviteUrl)}">Start free</a></div>
  <div class="card plan"><h3>Your own key</h3><div class="price">$0</div><ul><li>Unlimited renders</li><li>You pay Anthropic directly</li><li>Stored encrypted, set with <code>/setup</code></li></ul><a class="btn ghost" href="${esc(info.inviteUrl)}">Add to Discord</a></div>
</div><p class="fine">Upgrade from inside your server with <code>/plan</code>. Cancel anytime from the billing portal. Unused paid renders are refundable within 14 days.</p></section>
<section><h2>Questions</h2><div class="faq">
  <div class="card"><h3>What does it read?</h3><p>Only threads it created, plus a message that mentions it to start a session. Voice only after someone runs <code>/voice join</code>.</p></div>
  <div class="card"><h3>What do I get at the end?</h3><p>A single-file HTML page that runs anywhere, a decision log, and a BUILD.md written for Claude Code, Codex or Grok.</p></div>
  <div class="card"><h3>Does it keep our brand?</h3><p>Yes. Approved pages teach it your header, footer, colors and rules, so the next page starts on-brand.</p></div>
  <div class="card"><h3>Can I delete our data?</h3><p><code>/forget</code> deletes a session. Removing the bot stops all collection. See the privacy policy.</p></div>
</div></section>
${footer(info)}</div>`,
  );
}

export interface UpgradeView {
  guildName: string;
  plan: string;
  rendersLine: string;
  hasCustomer: boolean;
  hidden: { g: string; c: string; s: string };
  canceled?: boolean;
}

export function upgradePage(info: SiteInfo, v: UpgradeView): string {
  const hidden = `<input type="hidden" name="g" value="${esc(v.hidden.g)}"><input type="hidden" name="c" value="${esc(v.hidden.c)}"><input type="hidden" name="s" value="${esc(v.hidden.s)}">`;
  const onTeam = v.plan === "team";
  const teamCard = onTeam
    ? `<div class="card plan hot"><h3>Team</h3><div class="price">Active</div><ul><li>${info.teamRenders} renders a month</li><li>Change card, see invoices, or cancel in the portal</li></ul>${
        v.hasCustomer ? `<form method="post" action="/billing/portal">${hidden}<button class="btn ghost" type="submit">Manage billing</button></form>` : ""
      }</div>`
    : `<div class="card plan hot"><h3>Team</h3><div class="price">${esc(info.teamPrice)}</div><ul><li>${info.teamRenders} renders a month</li><li>Voice sessions</li><li>Cancel anytime</li></ul><form method="post" action="/checkout">${hidden}<input type="hidden" name="item" value="team"><button class="btn primary" type="submit">Subscribe</button></form></div>`;
  return shell(
    "Upgrade · Arbiter",
    `<div class="wrap">${nav(info)}<div class="center" style="max-width:900px">
<h1 style="font-size:40px">Upgrade ${esc(v.guildName)}</h1>
<p class="lede">Current plan: <b>${esc(v.plan)}</b>. ${esc(v.rendersLine)}</p>
${v.canceled ? `<p class="notice">Checkout was canceled. Nothing was charged.</p>` : ""}
<div class="plans" style="margin-top:28px">${teamCard}
<div class="card plan"><h3>Render pack</h3><div class="price">${esc(info.packPrice)}</div><ul><li>+${info.packRenders} renders</li><li>Never expire</li><li>Works on any plan</li></ul><form method="post" action="/checkout">${hidden}<input type="hidden" name="item" value="pack"><button class="btn ghost" type="submit">Buy a pack</button></form></div>
<div class="card plan"><h3>Your own key</h3><div class="price">$0</div><ul><li>Unlimited renders on your Anthropic key</li><li>Run <code>/setup key:</code> in your server</li><li>Needs Manage Server</li></ul></div>
</div><p class="fine">Payments are handled by Stripe. Promotion codes are accepted at checkout.</p></div>${footer(info)}</div>`,
  );
}

export function messagePage(info: SiteInfo, title: string, body: string): string {
  return shell(`${title} · Arbiter`, `<div class="wrap">${nav(info)}<div class="center"><h1 style="font-size:40px">${esc(title)}</h1><p class="lede">${body}</p></div>${footer(info)}</div>`);
}

export function setupPage(checks: { level: "fatal" | "warn" | "ok"; title: string; fix?: string }[], state: { discord: string }): string {
  const icon = { fatal: "⛔", warn: "⚠️", ok: "✅" } as const;
  const order = { fatal: 0, warn: 1, ok: 2 } as const;
  const rows = [...checks]
    .sort((a, b) => order[a.level] - order[b.level])
    .map((c) => `<div class="card" style="margin-bottom:10px;${c.level === "fatal" ? "border-color:#ef4444" : c.level === "warn" ? "border-color:#f59e0b" : ""}"><b>${icon[c.level]} ${esc(c.title)}</b>${c.fix ? `<p style="margin:6px 0 0;color:var(--dim)">${esc(c.fix)}</p>` : ""}</div>`)
    .join("");
  const fatal = checks.some((c) => c.level === "fatal");
  return shell(
    "Arbiter setup",
    `<div class="wrap"><div class="center" style="max-width:760px">
<h1 style="font-size:36px">${fatal ? "Arbiter isn't running yet" : "Arbiter status"}</h1>
<p class="lede">${fatal ? "The server is up, but the bot is offline until the items marked ⛔ are fixed. Change the variables in your host's dashboard; it redeploys and this page updates." : "The bot is running. Items marked ⚠️ are worth fixing."} Discord: <b>${esc(state.discord)}</b>.</p>
<div style="margin-top:24px">${rows}</div>
<p class="fine">No secret values are shown on this page. Full runbook: docs/GO-LIVE.md in the repo.</p>
</div></div>`,
  );
}
