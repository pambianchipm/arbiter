import { GuildMember } from "discord.js";
import type { Role } from "../types.js";

/** Map a member's Discord roles onto Arbiter roles, so a server that already has roles needs zero setup. */
export function inferRole(member: unknown): Role | undefined {
  if (!(member instanceof GuildMember)) return undefined;
  const names = member.roles.cache.map((r) => r.name.toLowerCase());
  if (names.some((n) => /design/.test(n))) return "designer";
  if (names.some((n) => /(^|\b)(pm|product)(\b|$)/.test(n))) return "pm";
  if (names.some((n) => /(eng|dev|frontend|backend)/.test(n))) return "eng";
  return undefined;
}

export function displayName(i: { member: unknown; user: { globalName: string | null; username: string } }): string {
  if (i.member instanceof GuildMember) return i.member.displayName;
  return i.user.globalName ?? i.user.username;
}
