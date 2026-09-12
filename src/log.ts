const start = Date.now();

function stamp(): string {
  const s = ((Date.now() - start) / 1000).toFixed(1).padStart(7);
  return `[${s}s]`;
}

export const log = {
  info: (...a: unknown[]) => console.log(stamp(), ...a),
  warn: (...a: unknown[]) => console.warn(stamp(), "WARN", ...a),
  error: (...a: unknown[]) => console.error(stamp(), "ERROR", ...a),
};

export function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
