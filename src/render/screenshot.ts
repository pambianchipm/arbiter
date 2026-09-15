import { chromium, type Browser } from "playwright";
import { log, errMsg } from "../log.js";

export interface ShotResult {
  png: Buffer;
  /** document.title of what was actually captured — lets callers detect a wrong page (proxy error, 404) */
  title: string;
  /** console errors + page errors captured while rendering; fed back to the model */
  warnings: string[];
  ms: number;
}

/**
 * One shared headless Chromium for the process. Each screenshot gets a fresh context,
 * captures console/page errors (so the agent can fix a broken render), and has hard
 * timeouts so a hung page never stalls the bot.
 */
export class Screenshotter {
  private browser: Browser | undefined;
  private launching: Promise<Browser> | undefined;

  constructor(private readonly executablePath?: string) {}

  private async getBrowser(): Promise<Browser> {
    if (this.browser && this.browser.isConnected()) return this.browser;
    if (!this.launching) {
      const proxy = process.env.ARBITER_BROWSER_PROXY;
      this.launching = chromium
        .launch({
          headless: true,
          executablePath: this.executablePath,
          // The preview server is local; only external references (Tailwind CDN, fonts, reference sites) go via the proxy.
          ...(proxy ? { proxy: { server: proxy, bypass: "localhost,127.0.0.1" } } : {}),
        })
        .then((b) => {
          this.browser = b;
          b.on("disconnected", () => {
            this.browser = undefined;
          });
          return b;
        })
        .finally(() => {
          this.launching = undefined;
        });
    }
    return this.launching;
  }

  async shoot(
    url: string,
    opts: { width?: number; height?: number; scale?: number; fullPage?: boolean; timeoutMs?: number; checkMobile?: boolean } = {},
  ): Promise<ShotResult> {
    const t0 = Date.now();
    const width = opts.width ?? 1280;
    const height = opts.height ?? 800;
    const timeout = opts.timeoutMs ?? 20_000;
    const browser = await this.getBrowser();
    const context = await browser.newContext({
      viewport: { width, height },
      deviceScaleFactor: opts.scale ?? 2,
      reducedMotion: "reduce",
      // Only for sandboxed CI behind a TLS-intercepting proxy. Never set this in a real deployment.
      ignoreHTTPSErrors: process.env.ARBITER_BROWSER_INSECURE_TLS === "1",
    });
    const warnings: string[] = [];
    try {
      const page = await context.newPage();
      page.on("console", (m) => {
        if (m.type() === "error") warnings.push(`console.error: ${trunc(m.text())}`);
      });
      page.on("pageerror", (e) => warnings.push(`page error: ${trunc(e.message)}`));
      page.on("requestfailed", (r) => {
        const u = r.url();
        // Tailwind/Google Fonts failures matter; tracking pixels and favicons do not.
        if (/favicon/.test(u)) return;
        warnings.push(`request failed: ${trunc(u)} (${r.failure()?.errorText ?? "?"})`);
      });
      page.setDefaultTimeout(timeout);
      // DOM first, then bounded waits for the load event (Tailwind CDN JIT, fonts) and network idle.
      // A slow or blocked CDN degrades the screenshot; it never fails the render.
      await page.goto(url, { waitUntil: "domcontentloaded", timeout });
      await page.waitForLoadState("load", { timeout: 10_000 }).catch(() => warnings.push("load event did not fire within 10s (continuing)"));
      await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => warnings.push("network did not go idle within 5s (continuing)"));
      // Compare pages embed variants in iframes; wait for each frame too (bounded).
      await Promise.all(
        page
          .frames()
          .filter((f) => f !== page.mainFrame())
          .map((f) => f.waitForLoadState("load", { timeout: 12_000 }).catch(() => warnings.push(`frame ${f.url()} did not finish loading within 12s (continuing)`))),
      );
      await page.evaluate(() => (document as unknown as { fonts?: { ready: Promise<unknown> } }).fonts?.ready).catch(() => undefined);
      await page.waitForTimeout(250);
      const png = await page.screenshot({ type: "png", fullPage: opts.fullPage ?? false });
      const title = await page.title().catch(() => "");
      // Horizontal overflow is the most common "looked fine in the screenshot, broken in the browser" bug.
      const overflow = async () => page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth })).catch(() => undefined);
      const d = await overflow();
      if (d && d.sw > d.iw + 1) warnings.push(`horizontal overflow at ${d.iw}px: page is ${d.sw}px wide (scrolls sideways)`);
      if (opts.checkMobile ?? true) {
        await page.setViewportSize({ width: 390, height: 844 }).catch(() => undefined);
        await page.waitForTimeout(120);
        const m = await overflow();
        if (m && m.sw > m.iw + 1) warnings.push(`horizontal overflow on mobile (390px): page is ${m.sw}px wide`);
      }
      return { png: Buffer.from(png), title, warnings, ms: Date.now() - t0 };
    } finally {
      await context.close().catch(() => undefined);
    }
  }

  /** Screenshot an arbitrary external site (reference study). Smaller scale, capped wait. */
  async shootExternal(url: string): Promise<ShotResult> {
    try {
      return await this.shoot(url, { width: 1280, height: 900, scale: 1, timeoutMs: 25_000, checkMobile: false });
    } catch (e) {
      log.warn("external screenshot failed", url, errMsg(e));
      throw e;
    }
  }

  async close(): Promise<void> {
    const b = this.browser;
    this.browser = undefined;
    await b?.close().catch(() => undefined);
  }
}

function trunc(s: string, n = 200): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}
