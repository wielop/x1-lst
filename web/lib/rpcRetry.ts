/**
 * Shared retry helper for X1 testnet RPC calls.
 *
 * X1 testnet's public RPC is both flaky (some backend nodes delinquent or on
 * a stale slot — see the FAQ docs) AND rate-limited (HTTP 429). Those need
 * different handling: a stale-node miss usually clears in a second or two,
 * but hammering a 429 with a short fixed delay just re-triggers the same
 * limit — every one of this app's several polling loops was doing that
 * independently, which is exactly what caused a real 429 storm in
 * production. This backs off much harder specifically on 429, adds jitter so
 * multiple components retrying at once don't resync on the same tick, and
 * caps attempts lower so a truly stuck endpoint fails fast instead of
 * multiplying load.
 */
function isRateLimited(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes("429") || msg.toLowerCase().includes("too many requests");
}

export async function withRetry<T>(fn: () => Promise<T>, attempts = 4): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (i >= attempts - 1) break;
      const base = isRateLimited(e) ? 4000 * 2 ** i : 800 * 2 ** i;
      const jitter = Math.random() * 400;
      await new Promise((r) => setTimeout(r, base + jitter));
    }
  }
  throw lastErr;
}

/** Prevents overlapping polls: if the previous tick is still running (e.g. mid-retry-backoff), skip this one rather than piling on more in-flight requests. */
export function createPoller(fn: () => Promise<void>) {
  let running = false;
  return async () => {
    if (running) return;
    running = true;
    try {
      await fn();
    } finally {
      running = false;
    }
  };
}
