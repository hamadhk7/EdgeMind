/** Short, prefixed, URL-safe ids such as `run_3f9a0c1b2d4e5f60a7b8`. */
export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`;
}

export function now(): number {
  return Date.now();
}

/** Epoch millis of the most recent UTC midnight. */
export function startOfUtcDay(at = Date.now()): number {
  const d = new Date(at);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}
