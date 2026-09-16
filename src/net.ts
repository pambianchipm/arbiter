import dns from "node:dns/promises";
import net from "node:net";

/** True for loopback, private, link-local, CGNAT, multicast and unspecified addresses (v4 and v6). */
export function isPrivateAddress(ip: string): boolean {
  const v = net.isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split(".").map(Number);
    return (
      a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127) || a >= 224
    );
  }
  if (v === 6) {
    const s = ip.toLowerCase();
    if (s === "::1" || s === "::") return true;
    if (s.startsWith("::ffff:")) return isPrivateAddress(s.slice(7));
    return s.startsWith("fc") || s.startsWith("fd") || s.startsWith("fe8") || s.startsWith("fe9") || s.startsWith("fea") || s.startsWith("feb") || s.startsWith("ff");
  }
  return true; // not an IP at all: refuse
}

/**
 * Only public http(s) URLs may be fetched or screenshotted. On a hosted box the browser can reach
 * localhost and cloud metadata; this is the guard against someone pointing study_reference there.
 */
export async function assertPublicHttpUrl(raw: string): Promise<URL> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error("not a valid URL");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("only http and https URLs are allowed");
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local") || host === "metadata.google.internal") {
    throw new Error("that host is not reachable from here");
  }
  if (u.username || u.password) throw new Error("URLs with credentials are not allowed");
  const literal = host.startsWith("[") ? host.slice(1, -1) : host;
  if (net.isIP(literal)) {
    if (isPrivateAddress(literal)) throw new Error("private addresses are not allowed");
    return u;
  }
  let addrs: { address: string }[];
  try {
    addrs = await dns.lookup(host, { all: true });
  } catch {
    throw new Error(`could not resolve ${host}`);
  }
  if (!addrs.length || addrs.some((a) => isPrivateAddress(a.address))) throw new Error(`${host} resolves to a private address`);
  return u;
}
