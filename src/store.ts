import { promises as fs } from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import type { Brand, GuildSettings, Project, Role } from "./types.js";

/**
 * Filesystem-backed store. One folder per project:
 *   <dataDir>/projects/<projectId>/state.json
 *   <dataDir>/projects/<projectId>/<versionId>.html
 *   <dataDir>/projects/<projectId>/<name>.png
 * Roles are per guild: <dataDir>/roles/<guildId>.json
 *
 * Writes are atomic (tmp + rename) so a crash mid-write never corrupts state.
 */
export class Store {
  private cache = new Map<string, Project>();
  private roleCache = new Map<string, Record<string, Role>>();
  private working = new Set<string>();
  /** per-project save chain: concurrent saves (a button click during a turn) are serialized, last write wins */
  private saveChains = new Map<string, Promise<void>>();
  /** emits "change" with a projectId whenever that project's state or activity changes (drives the live canvas) */
  readonly events = new EventEmitter();

  constructor(readonly dir: string) {
    this.events.setMaxListeners(200);
  }

  setWorking(projectId: string, on: boolean): void {
    if (on) this.working.add(projectId);
    else this.working.delete(projectId);
    this.events.emit("change", projectId);
  }

  isWorking(projectId: string): boolean {
    return this.working.has(projectId);
  }

  projectDir(id: string): string {
    return path.join(this.dir, "projects", safe(id));
  }

  async init(): Promise<void> {
    await fs.mkdir(path.join(this.dir, "projects"), { recursive: true });
    await fs.mkdir(path.join(this.dir, "roles"), { recursive: true });
  }

  async load(id: string): Promise<Project | undefined> {
    const hit = this.cache.get(id);
    if (hit) return hit;
    try {
      const raw = await fs.readFile(path.join(this.projectDir(id), "state.json"), "utf8");
      const p = JSON.parse(raw) as Project;
      this.cache.set(id, p);
      return p;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw e;
    }
  }

  has(id: string): boolean {
    return this.cache.has(id);
  }

  async save(p: Project): Promise<void> {
    this.cache.set(p.id, p);
    const dir = this.projectDir(p.id);
    const prev = this.saveChains.get(p.id) ?? Promise.resolve();
    const next = prev
      .catch(() => undefined)
      .then(async () => {
        await fs.mkdir(dir, { recursive: true });
        await atomicWrite(path.join(dir, "state.json"), JSON.stringify(p, null, 2));
      });
    this.saveChains.set(p.id, next);
    try {
      await next;
    } finally {
      if (this.saveChains.get(p.id) === next) this.saveChains.delete(p.id);
    }
    this.events.emit("change", p.id);
  }

  async listIds(): Promise<string[]> {
    try {
      const entries = await fs.readdir(path.join(this.dir, "projects"), { withFileTypes: true });
      return entries.filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      return [];
    }
  }

  async loadAll(): Promise<Project[]> {
    const out: Project[] = [];
    for (const id of await this.listIds()) {
      const p = await this.load(id);
      if (p) out.push(p);
    }
    return out;
  }

  htmlPath(projectId: string, versionId: string): string {
    return path.join(this.projectDir(projectId), `${safe(versionId)}.html`);
  }

  pngPath(projectId: string, name: string): string {
    return path.join(this.projectDir(projectId), `${safe(name)}.png`);
  }

  async writeHtml(projectId: string, versionId: string, html: string): Promise<string> {
    await fs.mkdir(this.projectDir(projectId), { recursive: true });
    const p = this.htmlPath(projectId, versionId);
    await atomicWrite(p, html);
    return p;
  }

  async readHtml(projectId: string, versionId: string): Promise<string | undefined> {
    try {
      return await fs.readFile(this.htmlPath(projectId, versionId), "utf8");
    } catch {
      return undefined;
    }
  }

  async writePng(projectId: string, name: string, png: Buffer): Promise<string> {
    await fs.mkdir(this.projectDir(projectId), { recursive: true });
    const p = this.pngPath(projectId, name);
    await fs.writeFile(p, png);
    return p;
  }

  async readPng(projectId: string, name: string): Promise<Buffer | undefined> {
    try {
      return await fs.readFile(this.pngPath(projectId, name));
    } catch {
      return undefined;
    }
  }

  // ---- guild settings (plan, renders, keys) ----

  async getGuild(guildId: string, defaults: { plan: GuildSettings["plan"]; renders: number }): Promise<GuildSettings> {
    const file = path.join(this.dir, "guilds", `${safe(guildId)}.json`);
    try {
      return JSON.parse(await fs.readFile(file, "utf8")) as GuildSettings;
    } catch {
      const now = new Date();
      const g: GuildSettings = {
        guildId,
        plan: defaults.plan,
        rendersRemaining: defaults.renders,
        renewsAt: new Date(now.getTime() + 30 * 86_400_000).toISOString(),
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      };
      await this.saveGuild(g);
      return g;
    }
  }

  async saveGuild(g: GuildSettings): Promise<void> {
    g.updatedAt = new Date().toISOString();
    await fs.mkdir(path.join(this.dir, "guilds"), { recursive: true });
    await atomicWrite(path.join(this.dir, "guilds", `${safe(g.guildId)}.json`), JSON.stringify(g, null, 2));
  }

  async listGuilds(): Promise<GuildSettings[]> {
    try {
      const names = (await fs.readdir(path.join(this.dir, "guilds"))).filter((f) => f.endsWith(".json"));
      const out: GuildSettings[] = [];
      for (const f of names) {
        try {
          out.push(JSON.parse(await fs.readFile(path.join(this.dir, "guilds", f), "utf8")) as GuildSettings);
        } catch {
          /* skip unreadable */
        }
      }
      return out;
    } catch {
      return [];
    }
  }

  async findGuildByCustomer(customerId: string): Promise<GuildSettings | undefined> {
    return (await this.listGuilds()).find((g) => g.stripeCustomerId === customerId);
  }

  async deleteProject(id: string): Promise<void> {
    this.cache.delete(id);
    await fs.rm(this.projectDir(id), { recursive: true, force: true });
    this.events.emit("change", id);
  }

  // ---- brands (per guild) ----

  private brandDir(guildId: string): string {
    return path.join(this.dir, "brands", safe(guildId));
  }

  async loadBrand(guildId: string, brandId: string): Promise<Brand | undefined> {
    try {
      return JSON.parse(await fs.readFile(path.join(this.brandDir(guildId), `${safe(brandId)}.json`), "utf8")) as Brand;
    } catch {
      return undefined;
    }
  }

  async saveBrand(b: Brand): Promise<void> {
    b.updatedAt = new Date().toISOString();
    await fs.mkdir(this.brandDir(b.guildId), { recursive: true });
    await atomicWrite(path.join(this.brandDir(b.guildId), `${safe(b.id)}.json`), JSON.stringify(b, null, 2));
  }

  async listBrands(guildId: string): Promise<Brand[]> {
    try {
      const names = (await fs.readdir(this.brandDir(guildId))).filter((f) => f.endsWith(".json") && f !== "_index.json");
      const out: Brand[] = [];
      for (const f of names) {
        const b = await this.loadBrand(guildId, f.replace(/\.json$/, ""));
        if (b) out.push(b);
      }
      return out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    } catch {
      return [];
    }
  }

  async getDefaultBrandId(guildId: string): Promise<string | undefined> {
    try {
      return (JSON.parse(await fs.readFile(path.join(this.brandDir(guildId), "_index.json"), "utf8")) as { lastBrandId?: string }).lastBrandId;
    } catch {
      return undefined;
    }
  }

  async setDefaultBrandId(guildId: string, brandId: string): Promise<void> {
    await fs.mkdir(this.brandDir(guildId), { recursive: true });
    await atomicWrite(path.join(this.brandDir(guildId), "_index.json"), JSON.stringify({ lastBrandId: brandId }, null, 2));
  }

  // ---- roles (per guild) ----

  async getRoles(guildId: string): Promise<Record<string, Role>> {
    const hit = this.roleCache.get(guildId);
    if (hit) return hit;
    try {
      const raw = await fs.readFile(path.join(this.dir, "roles", `${safe(guildId)}.json`), "utf8");
      const r = JSON.parse(raw) as Record<string, Role>;
      this.roleCache.set(guildId, r);
      return r;
    } catch {
      const r: Record<string, Role> = {};
      this.roleCache.set(guildId, r);
      return r;
    }
  }

  async setRole(guildId: string, userId: string, role: Role): Promise<void> {
    const r = await this.getRoles(guildId);
    r[userId] = role;
    await fs.mkdir(path.join(this.dir, "roles"), { recursive: true });
    await atomicWrite(path.join(this.dir, "roles", `${safe(guildId)}.json`), JSON.stringify(r, null, 2));
  }
}

function safe(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, "_");
}

let tmpCounter = 0;
async function atomicWrite(file: string, data: string): Promise<void> {
  const tmp = `${file}.${process.pid}.${++tmpCounter}.tmp`;
  await fs.writeFile(tmp, data, "utf8");
  await fs.rename(tmp, file);
}
