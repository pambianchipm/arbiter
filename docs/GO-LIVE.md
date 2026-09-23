# Go-live checklist

Order matters: Railway first (you need its URL), then Stripe (the webhook needs that URL), then
Discord (it needs the privacy and terms URLs). Do everything in Stripe **test mode** first, run the
test purchase at the end, then repeat the Stripe part in live mode.

Time: about an hour, plus Stripe's account review.

---

## 0. Before you start

- **Make a second Discord application for your laptop**, e.g. "Arbiter Dev". Put its token in your
  local `.env`. The production app's token goes only on Railway. Two processes on one token both
  answer every message, so the bot replies twice and fights itself.
- Generate two secrets and keep them somewhere safe:
  ```bash
  openssl rand -hex 32   # ARBITER_SECRET — never change it after launch (it encrypts saved keys and signs upgrade links)
  openssl rand -hex 16   # ADMIN_TOKEN — opens https://<domain>/live?admin=<token>
  ```
- Pick a contact email for the legal pages and the landing page.

## 1. Railway

1. **New Project → Deploy from GitHub repo → `pambianchipm/arbiter`.** Railway reads `railway.json`
   and builds the `Dockerfile` (Playwright's image, so Chromium just works). First build takes a few minutes.
2. **Add a volume** to the service, mount path **`/data`**. Sessions, brands and billing state live there.
   Without it, every deploy wipes them.
3. **Networking → Generate Domain** (or add your own domain and point a CNAME at it). That URL is
   `PUBLIC_BASE_URL` below.
4. **Variables → Raw Editor**, paste and fill:
   ```
   DISCORD_TOKEN=
   DISCORD_CLIENT_ID=
   ANTHROPIC_API_KEY=
   ARBITER_MODEL=claude-opus-5
   ARBITER_EFFORT=medium
   PUBLIC_BASE_URL=https://your-domain
   DATA_DIR=/data
   METERING=1
   ARBITER_SECRET=
   ADMIN_TOKEN=
   CONTACT_EMAIL=
   TEAM_PRICE_LABEL=$12 / month
   PACK_PRICE_LABEL=$5
   PACK_RENDERS=20
   ELEVENLABS_API_KEY=
   VOICE_MODE=address
   ```
   Leave `DISCORD_GUILD_ID` **out**: commands then register globally, on every server that adds the
   bot. The first time, they can take up to an hour to appear.
5. Deploy. The logs should show `discord ready as …`, `product · metering=true`, and
   `billing` will be absent until step 2 is done. Open `https://your-domain/`: you should see the
   landing page. `https://your-domain/health` returns `{"ok":true}`.

Railway runs one replica (set in `railway.json`). Keep it that way: two replicas means two bots.

## 2. Stripe

Do this in **test mode** first (the "Test mode" / sandbox toggle in the dashboard).

1. **A separate account for Arbiter.** Top-left account menu → **New account** → "Arbiter". This keeps
   payouts, receipts and the card statement separate from Clinkworthy. Fill in the activation form:
   business details, bank account, website = `https://your-domain` (Stripe reviews it; the landing page
   already shows pricing, refund terms, privacy, terms and contact, which is what they look for),
   statement descriptor `ARBITER`.
2. **Products → Add product**
   - **Arbiter Team**: recurring, **$12 USD monthly**. Save, open the price, copy its id `price_…` →
     `STRIPE_PRICE_TEAM`.
   - **Arbiter Render Pack**: one-off, **$5 USD**, description "20 renders, never expire". Copy the
     price id → `STRIPE_PRICE_PACK`.
   If you choose other prices, update `TEAM_PRICE_LABEL` / `PACK_PRICE_LABEL` / `PACK_RENDERS` to match.
3. **Settings → Billing → Customer portal**: turn it on. Allow *cancel subscription*, *update payment
   method*, *view invoice history*. Add your privacy and terms links. Save. (The "Manage billing"
   button on the upgrade page opens this.)
4. **Developers → Webhooks → Add endpoint** (in newer dashboards: Workbench → Webhooks → Add destination):
   - URL: `https://your-domain/stripe/webhook`
   - Events: `checkout.session.completed`, `invoice.paid`, `customer.subscription.deleted`
   - Copy the **signing secret** `whsec_…` → `STRIPE_WEBHOOK_SECRET`.
5. **Developers → API keys**: copy the **secret key** `sk_test_…` → `STRIPE_SECRET_KEY`.
   (Optional, safer: a restricted key with *Write* on Checkout Sessions and Customer portal. If
   checkout errors with a permissions message, use the standard secret key.)
6. **Settings → Branding**: icon, brand color, accent. It shows on the checkout page.
7. **Optional, founding price:** Products → Coupons → e.g. 50% off forever → add a promotion code
   `FOUNDER`. Checkout already accepts promotion codes.
8. Add the four `STRIPE_*` values to Railway and redeploy. The logs now show
   `billing · stripe test mode · webhook at https://your-domain/stripe/webhook`.

**Test purchase (in your server with the production bot):**
1. `/plan` → click the upgrade link → **Subscribe** → card `4242 4242 4242 4242`, any future date, any CVC.
2. You land on "Payment received", and within seconds the channel gets "🎉 This server is on Team".
   `/plan` shows Team and 40 renders.
3. Buy a pack the same way: "+20 renders".
4. Upgrade page → **Manage billing** → cancel (choose *immediately* to see it now). The server gets
   "Team plan has ended", `/plan` shows Free and the pack renders are still there.
5. Stripe → Webhooks → your endpoint should show all deliveries as 200.

**Go live:** switch to live mode. On each product use *Copy to live mode* (or recreate them),
create a **live** webhook endpoint (it has its own `whsec_…`), and take the **live** secret key.
Replace the four `STRIPE_*` variables on Railway and redeploy. The log line changes to `LIVE`.

Tax: if you need to collect sales tax/VAT, set up Stripe Tax, then `STRIPE_AUTOMATIC_TAX=1`.

## 3. Discord (production application)

1. **General Information**: icon, description ("A design agent for your team: live prototypes,
   A/B votes on disagreements, handoff for your coding agent"), **Privacy Policy URL**
   `https://your-domain/privacy`, **Terms of Service URL** `https://your-domain/terms`.
2. **Bot**: *Public Bot* on. *Message Content Intent* on. Leave the other privileged intents off.
3. **Installation**: guild install only (turn off *User Install*). The landing page builds its own
   invite link with the right scopes and permissions, so set *Install Link* to None or to the same
   scopes (`bot`, `applications.commands`).
4. Add the bot to a server from your landing page's **Add to Discord** button. You should get the
   welcome message within a second.
5. Later, at 75 servers: Discord asks you to verify (ID check + the URLs above). Then apply for the
   Message Content intent with the honest reason: *reads messages only in threads it created, to act
   on design feedback*. Approval can take weeks, so apply as soon as verification opens.

## 4. After launch

- Watch the Railway logs for `ERROR` and `billing:` lines for the first few days.
- `https://your-domain/live?admin=<ADMIN_TOKEN>` lists every session.
- Voice on Railway is untested. Discord voice needs outbound UDP. If `/voice join` stalls in
  `connecting` there, voice needs a host with UDP (Fly.io machines have it); everything else is unaffected.
- Keep `ARBITER_SECRET` forever. Rotating it breaks saved keys and every outstanding upgrade link.
