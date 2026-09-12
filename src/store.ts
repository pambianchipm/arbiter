import { promises as fs } from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import type { Project, Role } from "./types.js";

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
