/**
 * In-memory rate limiting — sliding window per API key + in-flight concurrency cap.
 *
 * Limits come from the customer's plan (rateLimitPerMinute, maxConcurrency) —
 * never hardcoded. Single-instance implementation; swap the store for Redis
 * when TaskFlow scales beyond one gateway process (interface unchanged).
 */

type Window = { timestamps: number[] };

const windows = new Map<string, Window>();
const inFlight = new Map<string, number>();

// Prevent unbounded growth: drop windows idle for > 10 minutes.
const GC_THRESHOLD_MS = 10 * 60 * 1000;
let lastGc = Date.now();

function gc(): void {
  const now = Date.now();
  if (now - lastGc < 60_000) return;
  lastGc = now;
  for (const [key, win] of windows) {
    if (win.timestamps.length === 0 || now - win.timestamps[win.timestamps.length - 1] > GC_THRESHOLD_MS) {
      windows.delete(key);
      if (!inFlight.has(key)) inFlight.delete(key);
    }
  }
}

export type RateLimitResult = {
  allowed: boolean;
  limit: number;
  remaining: number;
  retryAfterSeconds: number;
};

export function checkRateLimit(keyId: string, limitPerMinute: number): RateLimitResult {
  gc();
  const now = Date.now();
  const windowMs = 60_000;
  const win = windows.get(keyId) ?? { timestamps: [] };
  win.timestamps = win.timestamps.filter((t) => now - t < windowMs);

  if (win.timestamps.length >= limitPerMinute) {
    const oldest = win.timestamps[0];
    windows.set(keyId, win);
    return {
      allowed: false,
      limit: limitPerMinute,
      remaining: 0,
      retryAfterSeconds: Math.max(1, Math.ceil((oldest + windowMs - now) / 1000)),
    };
  }
  win.timestamps.push(now);
  windows.set(keyId, win);
  return {
    allowed: true,
    limit: limitPerMinute,
    remaining: limitPerMinute - win.timestamps.length,
    retryAfterSeconds: 0,
  };
}

export function tryAcquireConcurrency(keyId: string, maxConcurrency: number): boolean {
  const current = inFlight.get(keyId) ?? 0;
  if (current >= maxConcurrency) return false;
  inFlight.set(keyId, current + 1);
  return true;
}

export function releaseConcurrency(keyId: string): void {
  const current = inFlight.get(keyId) ?? 0;
  inFlight.set(keyId, Math.max(0, current - 1));
}

export function currentInFlight(keyId: string): number {
  return inFlight.get(keyId) ?? 0;
}
