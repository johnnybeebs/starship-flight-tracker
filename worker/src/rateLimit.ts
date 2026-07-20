// Sliding-window rate limiter backed by KV (timestamps JSON array).

const WINDOW_S = 3600;

export interface RateLimitResult {
  ok: boolean;
  remaining: number;
  retryAfterS: number;
  count: number;
}

async function loadWindow(
  kv: KVNamespace,
  key: string,
  windowS: number
): Promise<number[]> {
  const now = Date.now() / 1000;
  const cutoff = now - windowS;
  const raw = await kv.get(key);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((t): t is number => typeof t === "number" && t >= cutoff);
  } catch {
    return [];
  }
}

/** Read-only check — does not record an attempt. */
export async function peekRateLimit(
  kv: KVNamespace,
  key: string,
  limit: number,
  windowS: number = WINDOW_S
): Promise<RateLimitResult> {
  const times = await loadWindow(kv, key, windowS);
  if (times.length >= limit) {
    const now = Date.now() / 1000;
    const oldest = times[0] ?? now;
    return {
      ok: false,
      remaining: 0,
      retryAfterS: Math.max(1, Math.ceil(oldest + windowS - now)),
      count: times.length,
    };
  }
  return {
    ok: true,
    remaining: Math.max(0, limit - times.length),
    retryAfterS: 0,
    count: times.length,
  };
}

/** Record one attempt; returns whether it was under the limit afterward. */
export async function consumeRateLimit(
  kv: KVNamespace,
  key: string,
  limit: number,
  windowS: number = WINDOW_S
): Promise<RateLimitResult> {
  const peek = await peekRateLimit(kv, key, limit, windowS);
  if (!peek.ok) return peek;

  const now = Date.now() / 1000;
  const times = await loadWindow(kv, key, windowS);
  times.push(now);
  await kv.put(key, JSON.stringify(times), { expirationTtl: windowS + 120 });
  return {
    ok: true,
    remaining: Math.max(0, limit - times.length),
    retryAfterS: 0,
    count: times.length,
  };
}

export function clientIp(request: Request): string {
  return (
    request.headers.get("cf-connecting-ip") ||
    request.headers.get("x-real-ip") ||
    "unknown"
  );
}
