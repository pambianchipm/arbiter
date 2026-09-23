import express from "express";
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Orchestrator } from "./orchestrator.js";
import { messagePage, upgradePage, type SiteInfo } from "./web/pages.js";
import { log, errMsg } from "./log.js";

/** The slice of the Stripe SDK we use. The real client satisfies it; tests pass a fake. */
export interface StripeLike {
  checkout: { sessions: { create(params: Record<string, unknown>): Promise<{ url: string | null }> } };
  billingPortal: { sessions: { create(params: Record<string, unknown>): Promise<{ url: string }> } };
  webhooks: { constructEvent(payload: Buffer | string, header: string, secret: string): { id: string; type: string; data: { object: unknown } } };
}

export interface BillingDeps {
  stripe: StripeLike;
  webhookSecret: string;
  /** ARBITER_SECRET: signs upgrade links so server ids can't be browsed */
  secret: string;
  baseUrl: string;
  prices: { team: string; pack: string };
  automaticTax?: boolean;
  site: SiteInfo;
  orch: Orchestrator;
  guildName: (guildId: string) => Promise<string | undefined>;
  /** post a line into the channel the upgrade started from (or the server's system channel) */
  notify: (guildId: string, channelId: string | undefined, text: string) => Promise<void>;
}

export function signUpgrade(secret: string, guildId: string, channelId = ""): string {
  return createHmac("sha256", secret).update(`upgrade:${guildId}:${channelId}`).digest("base64url").slice(0, 22);
}

function validSig(secret: string, g: string, c: string, s: string): boolean {
  const want = Buffer.from(signUpgrade(secret, g, c));
  const got = Buffer.from(s);
  return /^\d{5,25}$/.test(g) && (c === "" || /^\d{5,25}$/.test(c)) && want.length === got.length && timingSafeEqual(want, got);
}

export function billingLink(baseUrl: string, secret: string, guildId: string, channelId?: string): string {
  const q = new URLSearchParams({ g: guildId, s: signUpgrade(secret, guildId, channelId ?? "") });
  if (channelId) q.set("c", channelId);
  return `${baseUrl}/upgrade?${q.toString()}`;
}

type Obj = Record<string, unknown>;
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

export function mountBilling(app: express.Express, d: BillingDeps): void {
  const params = (src: Obj) => ({ g: String(src.g ?? ""), c: String(src.c ?? ""), s: String(src.s ?? "") });
  const qs = (p: { g: string; c: string; s: string }) => new URLSearchParams({ g: p.g, s: p.s, ...(p.c ? { c: p.c } : {}) }).toString();
  const bad = (res: express.Response) => res.status(403).type("html").send(messagePage(d.site, "Link expired", "This upgrade link isn't valid. Run <code>/plan</code> in your server for a fresh one."));

  app.get("/upgrade", async (req, res) => {
    const p = params(req.query as Obj);
    if (!validSig(d.secret, p.g, p.c, p.s)) return bad(res);
    const g = await d.orch.guild(p.g);
    const name = (await d.guildName(p.g)) ?? "your server";
    const names: Record<string, string> = { free: "Free", team: "Team", byok: "Your own key" };
    const rendersLine = g.byokKeyEnc
      ? "Running on your own Anthropic key: renders are unlimited."
      : `${g.rendersRemaining} of this month's renders left${g.bonusRenders ? `, plus ${g.bonusRenders} from packs` : ""}.`;
    res.type("html").send(upgradePage(d.site, { guildName: name, plan: names[g.plan] ?? g.plan, rendersLine, hasCustomer: Boolean(g.stripeCustomerId), hidden: p, canceled: req.query.canceled === "1" }));
  });

  app.post("/checkout", express.urlencoded({ extended: false, limit: "4kb" }), async (req, res) => {
    const p = params(req.body as Obj);
    const item = (req.body as Obj).item === "team" ? "team" : (req.body as Obj).item === "pack" ? "pack" : undefined;
    if (!validSig(d.secret, p.g, p.c, p.s) || !item) return bad(res);
    const g = await d.orch.guild(p.g);
    if (item === "team" && g.plan === "team") return res.redirect(303, `/upgrade?${qs(p)}`);
    try {
      const session = await d.stripe.checkout.sessions.create({
        mode: item === "team" ? "subscription" : "payment",
        line_items: [{ price: item === "team" ? d.prices.team : d.prices.pack, quantity: 1 }],
        success_url: `${d.baseUrl}/upgrade/done?${qs(p)}&item=${item}`,
        cancel_url: `${d.baseUrl}/upgrade?${qs(p)}&canceled=1`,
        client_reference_id: p.g,
        metadata: { guildId: p.g, channelId: p.c, item },
        allow_promotion_codes: true,
        ...(item === "team" ? { subscription_data: { metadata: { guildId: p.g } } } : {}),
        ...(g.stripeCustomerId ? { customer: g.stripeCustomerId } : item === "pack" ? { customer_creation: "always" } : {}),
        ...(d.automaticTax ? { automatic_tax: { enabled: true }, ...(g.stripeCustomerId ? { customer_update: { address: "auto" } } : {}) } : {}),
      });
      if (!session.url) throw new Error("Stripe returned no checkout URL");
      res.redirect(303, session.url);
    } catch (e) {
      log.error("stripe checkout:", errMsg(e));
      res.status(502).type("html").send(messagePage(d.site, "Checkout is unavailable", "Stripe didn't accept the request. Nothing was charged. Try again in a minute, or contact us."));
    }
  });

  app.get("/upgrade/done", async (req, res) => {
    const p = params(req.query as Obj);
    if (!validSig(d.secret, p.g, p.c, p.s)) return bad(res);
    const what = req.query.item === "pack" ? `${d.site.packRenders} renders were added` : "Your server is on the Team plan";
    res.type("html").send(messagePage(d.site, "Payment received", `${what}. It can take a few seconds to show up. Head back to Discord; Arbiter will post a confirmation in the channel you came from.`));
  });

  app.post("/billing/portal", express.urlencoded({ extended: false, limit: "4kb" }), async (req, res) => {
    const p = params(req.body as Obj);
    if (!validSig(d.secret, p.g, p.c, p.s)) return bad(res);
    const g = await d.orch.guild(p.g);
    if (!g.stripeCustomerId) return res.redirect(303, `/upgrade?${qs(p)}`);
    try {
      const portal = await d.stripe.billingPortal.sessions.create({ customer: g.stripeCustomerId, return_url: `${d.baseUrl}/upgrade?${qs(p)}` });
      res.redirect(303, portal.url);
    } catch (e) {
      log.error("stripe portal:", errMsg(e));
      res.status(502).type("html").send(messagePage(d.site, "Billing portal is unavailable", "Stripe didn't open the portal. Make sure the customer portal is enabled in the Stripe dashboard, then try again."));
    }
  });

  // Stripe needs the exact bytes it signed, so this route takes a raw body.
  app.post("/stripe/webhook", express.raw({ type: "*/*", limit: "1mb" }), async (req, res) => {
    let event: { id: string; type: string; data: { object: unknown } };
    try {
      event = d.stripe.webhooks.constructEvent(req.body as Buffer, String(req.headers["stripe-signature"] ?? ""), d.webhookSecret);
    } catch (e) {
      log.warn("stripe webhook: bad signature:", errMsg(e));
      res.status(400).send("bad signature");
      return;
    }
    try {
      await handleEvent(d, event);
      res.json({ received: true });
    } catch (e) {
      log.error(`stripe webhook ${event.type} failed:`, errMsg(e));
      res.status(500).send("handler error"); // Stripe retries
    }
  });
}

async function handleEvent(d: BillingDeps, event: { id: string; type: string; data: { object: unknown } }): Promise<void> {
  const o = (event.data.object ?? {}) as Obj;
  const meta = (o.metadata ?? {}) as Obj;
  switch (event.type) {
    case "checkout.session.completed": {
      const guildId = str(meta.guildId) ?? str(o.client_reference_id);
      if (!guildId) return;
      const channelId = str(meta.channelId);
      const customer = str(o.customer);
      if (o.mode === "subscription" && (o.payment_status === "paid" || o.payment_status === "no_payment_required")) {
        if (await d.orch.billingTeamStarted(guildId, event.id, customer, str(o.subscription))) {
          log.info(`billing: ${guildId} → team`);
          await d.notify(guildId, channelId, `🎉 This server is on **Team** now: ${d.site.teamRenders} renders a month, plus voice. Thanks for backing Arbiter.`).catch(() => undefined);
        }
      } else if (o.mode === "payment" && o.payment_status === "paid") {
        if (await d.orch.billingPackBought(guildId, event.id, customer)) {
          log.info(`billing: ${guildId} +pack`);
          await d.notify(guildId, channelId, `🎉 ${d.site.packRenders} renders added. They never expire. \`/plan\` shows the balance.`).catch(() => undefined);
        }
      }
      return;
    }
    case "invoice.paid": {
      const customer = str(o.customer);
      if (customer && o.billing_reason === "subscription_cycle") {
        const g = await d.orch.billingRenewed(customer, event.id);
        if (g) log.info(`billing: ${g.guildId} renewed`);
      }
      return;
    }
    case "customer.subscription.deleted": {
      const customer = str(o.customer);
      if (!customer) return;
      const g = await d.orch.billingCanceled(customer, event.id);
      if (g) {
        log.info(`billing: ${g.guildId} canceled → ${g.plan}`);
        await d.notify(g.guildId, undefined, `Arbiter's Team plan for this server has ended. You're on ${g.plan === "byok" ? "your own key" : "Free"} now; pack renders you bought are still here. \`/plan\` to resubscribe.`).catch(() => undefined);
      }
      return;
    }
    default:
      return; // other events are acknowledged and ignored
  }
}
