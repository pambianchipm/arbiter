import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/** AES-256-GCM with a key derived from ARBITER_SECRET. Used for bring-your-own-key API keys at rest. */
function keyFrom(secret: string): Buffer {
  return createHash("sha256").update(secret).digest();
}

export function encrypt(plain: string, secret: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", keyFrom(secret), iv);
  const enc = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return `v1.${iv.toString("base64url")}.${c.getAuthTag().toString("base64url")}.${enc.toString("base64url")}`;
}

export function decrypt(blob: string, secret: string): string {
  const [v, iv, tag, data] = blob.split(".");
  if (v !== "v1" || !iv || !tag || !data) throw new Error("bad ciphertext");
  const d = createDecipheriv("aes-256-gcm", keyFrom(secret), Buffer.from(iv, "base64url"));
  d.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([d.update(Buffer.from(data, "base64url")), d.final()]).toString("utf8");
}

/** Show a key's shape without revealing it: sk-ant-…3f9a */
export function maskKey(key: string): string {
  return key.length <= 10 ? "••••" : `${key.slice(0, 7)}…${key.slice(-4)}`;
}
