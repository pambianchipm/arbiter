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

  // ---- Live canvas: one URL that always shows the latest state. Screen-share this tab.
  app.get("/live/:project", async (req, res) => {
    const { project } = req.params as Record<string, string>;
    const p = await store.load(project);
    if (!p) {
      res.status(404).type("text/plain").send("project not found");
      return;
    }
    res.setHeader("Cache-Control", "no-store");
    res.type("html").send(livePage(project));
  });

  app.get("/live/:project/state", async (req, res) => {
    const { project } = req.params as Record<string, string>;
    const p = await store.load(project);
    if (!p) {
      res.status(404).json({ error: "not found" });
      return;
    }
    const cur = p.versions.find((v) => v.id === p.currentVersionId);
    const lastAgent = [...p.transcript].reverse().find((t) => t.kind === "agent");
    const fork = p.fork && !p.fork.resolved ? p.fork : undefined;
    res.setHeader("Cache-Control", "no-store");
    res.json({
      brief: p.brief,
      status: p.status,
      working: store.isWorking(project),
      participants: Object.values(p.participants).map((x) => ({ name: x.name, role: x.role ?? null })),
      current: cur ? { id: cur.id, summary: cur.summary, approvals: cur.approvals.length, changes: cur.changes } : null,
      fork: fork
        ? {
            id: fork.id,
            question: fork.question,
            a: { versionId: fork.a.versionId, label: fork.a.label, votes: Object.values(fork.votes).filter((v) => v === "a").length },
            b: { versionId: fork.b.versionId, label: fork.b.label, votes: Object.values(fork.votes).filter((v) => v === "b").length },
          }
        : null,
      constraints: p.constraints.map((c) => c.text),
      lastAgent: lastAgent?.text ?? null,
      versions: p.versions.length,
      decisions: p.decisions.length,
    });
  });

  app.get("/live/:project/events", (req, res) => {
    const { project } = req.params as Record<string, string>;
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
    res.write("data: hello\n\n");
    const onChange = (id: string) => {
      if (id === project) res.write("data: change\n\n");
    };
    store.events.on("change", onChange);
    const beat = setInterval(() => res.write(": ping\n\n"), 25_000);
    req.on("close", () => {
      clearInterval(beat);
      store.events.off("change", onChange);
    });
  });

  // Index: every session with a link to its live canvas. Also answers a bare /live.
  app.get(["/", "/live"], async (_req, res) => {
    const all = await store.loadAll();
    all.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    res.setHeader("Cache-Control", "no-store");
    res.type("html").send(indexPage(all.map((p) => ({ ...p, working: store.isWorking(p.id) }))));
  });

  return app;
}

export function listen(app: express.Express, port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, () => {
      const addr = server.address();
      const actual = typeof addr === "object" && addr ? addr.port : port;
      log.info(`preview server on http://localhost:${actual}`);
      resolve(server);
    });
    server.on("error", (e: NodeJS.ErrnoException) => {
      if (e.code === "EADDRINUSE") {
        reject(new Error(`port ${port} is already in use. Another Arbiter (or an old dry run) is probably still running: close it, or set PORT to something else in .env.`));
      } else reject(e);
    });
  });
}

/** Like listen(), but if the port is busy, fall back to a random free port and say so. Used by the dry run. */
export async function listenOrFallback(app: express.Express, port: number): Promise<Server> {
  try {
    return await listen(app, port);
  } catch (e) {
    log.warn(`${(e as Error).message} Falling back to a random free port for this run.`);
    return listen(app, 0);
  }
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


function indexPage(projects: Array<import("../types.js").Project & { working: boolean }>): string {
  const esc = (x: string) => x.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
  const rows = projects.length
    ? projects
        .map((p) => {
          const cur = p.versions.find((v) => v.id === p.currentVersionId);
          const fork = p.fork && !p.fork.resolved;
          const pill = p.working ? '<span class="pill work">working…</span>' : fork ? '<span class="pill vote">vote open</span>' : p.status === "shipped" ? '<span class="pill ok">shipped</span>' : '<span class="pill">active</span>';
          return `<a class="row" href="/live/${esc(p.id)}"><div class="brief">${esc(p.brief)}</div><div class="meta">${cur ? esc(cur.id) + " · " : ""}${p.versions.length} versions · ${p.decisions.length} decisions · ${Object.values(p.participants).map((x) => esc(x.name)).join(", ") || "—"}</div>${pill}</a>`;
        })
        .join("")
    : '<div class="empty">No sessions yet. Start one in Discord with <code>/design</code> or run <code>npm run dry -- "your brief"</code>.</div>';
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Arbiter · sessions</title>
<meta http-equiv="refresh" content="5">
<style>
  :root{--bg:#0f1115;--panel:#171a21;--line:#2a2f3a;--fg:#e6e8ee;--dim:#9aa3b2;--blue:#3b82f6;--pink:#ec4899;--green:#22c55e}
  html,body{margin:0;background:var(--bg);color:var(--fg);font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
  .wrap{max-width:900px;margin:0 auto;padding:32px 20px}
  h1{font-size:22px;margin:0 0 4px} .sub{color:var(--dim);margin:0 0 24px}
  .row{display:grid;grid-template-columns:1fr auto;gap:4px 16px;align-items:center;background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:14px 16px;margin-bottom:10px;text-decoration:none;color:inherit}
  .row:hover{border-color:var(--blue)}
  .brief{font-weight:700;font-size:16px} .meta{color:var(--dim);font-size:13px;grid-column:1}
  .pill{grid-row:1/span 2;font-size:12px;padding:4px 10px;border-radius:999px;border:1px solid var(--line);color:var(--dim);white-space:nowrap}
  .pill.ok{color:#fff;border-color:var(--green);background:rgba(34,197,94,.18)}
  .pill.vote{color:#fff;border-color:var(--pink);background:rgba(236,72,153,.18)}
  .pill.work{color:#fff;border-color:var(--blue);background:rgba(59,130,246,.18);animation:pulse 1.2s ease-in-out infinite}
  @keyframes pulse{0%,100%{opacity:1}50%{opacity:.45}}
  .empty{color:var(--dim);padding:40px 0;text-align:center} code{background:var(--panel);padding:2px 6px;border-radius:6px}
</style></head>
<body><div class="wrap"><h1>Arbiter sessions</h1><p class="sub">Click a session to open its live canvas. This list refreshes every 5s.</p>${rows}</div></body></html>`;
}

function livePage(project: string): string {
  const esc = (x: string) => x.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
  const pid = esc(project);
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Arbiter · live</title>
<style>
  :root{--bg:#0f1115;--panel:#171a21;--line:#2a2f3a;--fg:#e6e8ee;--dim:#9aa3b2;--blue:#3b82f6;--pink:#ec4899;--green:#22c55e}
  html,body{margin:0;height:100%;background:var(--bg);color:var(--fg);font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
  body{display:grid;grid-template-rows:auto 1fr auto;height:100vh}
  header{display:flex;align-items:center;gap:14px;padding:12px 18px;border-bottom:1px solid var(--line)}
  header .brief{font-weight:700;font-size:18px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .pill{font-size:12px;padding:4px 10px;border-radius:999px;border:1px solid var(--line);color:var(--dim);white-space:nowrap}
  .pill.v{color:#fff;border-color:var(--blue);background:rgba(59,130,246,.18)}
  .pill.ok{color:#fff;border-color:var(--green);background:rgba(34,197,94,.18)}
  .pill.work{color:#fff;border-color:var(--pink);background:rgba(236,72,153,.18);animation:pulse 1.2s ease-in-out infinite}
  @keyframes pulse{0%,100%{opacity:1}50%{opacity:.45}}
  main{display:grid;gap:16px;padding:16px;min-height:0}
  main.single{grid-template-columns:1fr}
  main.split{grid-template-columns:1fr 1fr}
  .card{background:var(--panel);border:1px solid var(--line);border-radius:14px;overflow:hidden;display:flex;flex-direction:column;min-height:0}
  .hd{display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid var(--line);font-weight:700}
  .badge{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:8px;font-weight:800}
  .a .badge{background:var(--blue)} .b .badge{background:var(--pink)}
  .votes{margin-left:auto;color:var(--dim);font-weight:500}
  iframe{flex:1;width:100%;border:0;background:#fff}
  footer{display:flex;align-items:center;gap:14px;padding:10px 18px;border-top:1px solid var(--line);color:var(--dim);font-size:14px;min-height:22px}
  footer .msg{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1}
  .empty{display:grid;place-items:center;color:var(--dim);font-size:18px}
</style></head>
<body>
<header><div class="brief" id="brief">Arbiter</div><span class="pill v" id="ver">—</span><span class="pill" id="people"></span><span class="pill work" id="work" hidden>Arbiter is working…</span><span class="pill ok" id="shipped" hidden>Shipped</span></header>
<main class="single" id="main"><div class="empty">Waiting for the first version…</div></main>
<footer><div class="msg" id="msg"></div><div id="meta"></div></footer>
<script>
  const P = ${JSON.stringify(project)};
  let shown = "";
  async function refresh(){
    const r = await fetch("/live/"+P+"/state",{cache:"no-store"}); if(!r.ok) return; const s = await r.json();
    document.getElementById("brief").textContent = s.brief;
    document.getElementById("work").hidden = !s.working;
    document.getElementById("shipped").hidden = s.status !== "shipped";
    document.getElementById("people").textContent = s.participants.map(p=>p.name+(p.role?" · "+p.role:"")).join("  ·  ");
    document.getElementById("msg").textContent = s.lastAgent || "";
    document.getElementById("meta").textContent = s.versions+" versions · "+s.decisions+" decisions · "+s.constraints.length+" constraints";
    const main = document.getElementById("main");
    if (s.fork) {
      document.getElementById("ver").textContent = "Vote: "+s.fork.question;
      const key = "fork:"+s.fork.id+":"+s.fork.a.votes+":"+s.fork.b.votes;
      if (shown === key) return; shown = key;
      main.className = "split";
      main.innerHTML = side("a", s.fork.a) + side("b", s.fork.b);
    } else if (s.current) {
      document.getElementById("ver").textContent = s.current.id+" · "+s.current.summary+(s.current.approvals?" · ✅ "+s.current.approvals:"");
      const key = "v:"+s.current.id;
      if (shown === key) return; shown = key;
      main.className = "single";
      main.innerHTML = '<div class="card"><iframe src="/p/'+P+'/'+s.current.id+'"></iframe></div>';
    }
  }
  function side(k, v){ return '<div class="card '+k+'"><div class="hd"><span class="badge">'+k.toUpperCase()+'</span><span>'+esc(v.label)+'</span><span class="votes">'+v.votes+' vote'+(v.votes===1?"":"s")+'</span></div><iframe src="/p/'+P+'/'+v.versionId+'"></iframe></div>'; }
  function esc(x){ return String(x).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c]); }
  const es = new EventSource("/live/"+P+"/events");
  es.onmessage = () => refresh();
  es.onerror = () => setTimeout(refresh, 2000);
  refresh(); setInterval(refresh, 10000);
</script>
</body></html>`;
}
