import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SecureCache } from "../../../src/utils/SecureCache";

describe("SecureCache", () => {
  let cache: SecureCache<string>;

  beforeEach(() => {
    vi.useFakeTimers();
    cache = new SecureCache<string>(1000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("stores, overwrites, and clears values", () => {
    cache.set("key1", "value1");
    expect(cache.get("key1")).toBe("value1");

    cache.set("key1", "value2");
    cache.set("key2", "value3");
    expect(cache.get("key1")).toBe("value2");
    expect(cache.get("key2")).toBe("value3");

    cache.clear();
    expect(cache.get("key1")).toBeUndefined();
    expect(cache.get("key2")).toBeUndefined();
  });

  it("reports existing keys and deletes them", () => {
    cache.set("key1", "value1");

    expect(cache.has("key1")).toBe(true);
    expect(cache.delete("key1")).toBe(true);
    expect(cache.has("key1")).toBe(false);
    expect(cache.delete("missing")).toBe(false);
  });

  it("expires entries after ttl", () => {
    cache.set("key1", "value1");
    vi.advanceTimersByTime(500);
    expect(cache.get("key1")).toBe("value1");

    vi.advanceTimersByTime(501);
    expect(cache.get("key1")).toBeUndefined();
  });

  it("cleans up expired entries", () => {
    cache.set("key1", "value1");
    vi.advanceTimersByTime(500);
    cache.set("key2", "value2");
    vi.advanceTimersByTime(600);

    cache.cleanup();

    expect(cache.get("key1")).toBeUndefined();
    expect(cache.get("key2")).toBe("value2");
  });

  it("can stop automatic cleanup", () => {
    const stopCleanup = cache.startAutoCleanup(100);

    cache.set("key1", "value1");
    vi.advanceTimersByTime(500);
    stopCleanup();
    vi.advanceTimersByTime(500);

    expect(cache.get("key1")).toBe("value1");
  });
});
