import express from "express";
import type { Server } from "node:http";
import type { Store } from "../store.js";
import { log } from "../log.js";

/**
 * Serves rendered prototypes so (a) Playwright can screenshot them through a real
 * URL — same path a human takes — and (b) the team gets a live link in Discord.
 *
 *   GET /p/:project/:version            → the HTML for that version
 *   GET /p/:project/compare/:a/:b       → A | B side by side (used for fork screenshots)
 *   GET /health
 */
export function createPreviewServer(store: Store): express.Express {
  const app = express();
  app.disable("x-powered-by");

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.get("/p/:project/compare/:a/:b", async (req, res) => {
    const { project, a, b } = req.params as Record<string, string>;
    const [ha, hb] = await Promise.all([store.readHtml(project, a), store.readHtml(project, b)]);
    if (!ha || !hb) {
      res.status(404).type("text/plain").send("variant not found");
      return;
    }
    res.type("html").send(comparePage(project, a, b));
  });

  app.get("/p/:project/:version", async (req, res) => {
    const { project, version } = req.params as Record<string, string>;
    const html = await store.readHtml(project, version);
    if (!html) {
      res.status(404).type("text/plain").send("version not found");
      return;
    }
    res.setHeader("Cache-Control", "no-store");
    res.type("html").send(html);
  });

  app.get("/", (_req, res) => {
    res.type("text/plain").send("arbiter preview server");
  });

  return app;
}

export function listen(app: express.Express, port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, () => {
      log.info(`preview server on http://localhost:${port}`);
      resolve(server);
    });
    server.on("error", reject);
  });
}

function comparePage(project: string, a: string, b: string): string {
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Compare ${esc(a)} vs ${esc(b)}</title>
<style>
  html,body{margin:0;background:#0f1115;font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#e6e8ee}
  .wrap{display:grid;grid-template-columns:1fr 1fr;gap:24px;padding:20px;width:2600px;box-sizing:border-box}
  .card{background:#171a21;border:1px solid #2a2f3a;border-radius:14px;overflow:hidden}
  .hd{display:flex;align-items:center;gap:12px;padding:12px 16px;font-size:22px;font-weight:700;border-bottom:1px solid #2a2f3a}
  .badge{display:inline-flex;align-items:center;justify-content:center;width:36px;height:36px;border-radius:10px;font-weight:800;font-size:20px}
  .a .badge{background:#3b82f6;color:#fff}.b .badge{background:#ec4899;color:#fff}
  iframe{display:block;width:1280px;height:800px;border:0;background:#fff}
</style></head>
<body><div class="wrap">
  <div class="card a"><div class="hd"><span class="badge">A</span><span>${esc(a)}</span></div><iframe src="/p/${esc(project)}/${esc(a)}"></iframe></div>
  <div class="card b"><div class="hd"><span class="badge">B</span><span>${esc(b)}</span></div><iframe src="/p/${esc(project)}/${esc(b)}"></iframe></div>
</div></body></html>`;
}
