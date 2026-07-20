import { describe, expect, it, vi } from "vitest";
import { consumeRateLimit, peekRateLimit } from "../src/rateLimit";

function memoryKv() {
  const store = new Map<string, string>();
  return {
    async get(key: string) {
      return store.get(key) ?? null;
    },
    async put(key: string, value: string) {
      store.set(key, value);
    },
    store,
  } as unknown as KVNamespace;
}

describe("rateLimit", () => {
  it("allows up to the limit then blocks", async () => {
    const kv = memoryKv();
    expect((await peekRateLimit(kv, "k", 2)).ok).toBe(true);
    expect((await consumeRateLimit(kv, "k", 2)).remaining).toBe(1);
    expect((await consumeRateLimit(kv, "k", 2)).remaining).toBe(0);
    const blocked = await consumeRateLimit(kv, "k", 2);
    expect(blocked.ok).toBe(false);
    expect(blocked.retryAfterS).toBeGreaterThan(0);
  });

  it("peek does not consume", async () => {
    const kv = memoryKv();
    await peekRateLimit(kv, "k", 1);
    await peekRateLimit(kv, "k", 1);
    expect((await consumeRateLimit(kv, "k", 1)).ok).toBe(true);
    expect((await peekRateLimit(kv, "k", 1)).ok).toBe(false);
  });
});
