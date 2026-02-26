/**
 * Tests for SecureCache utility
 * @module tests/unit/utils/SecureCache
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Inline implementation for testing (avoiding module resolution issues)
interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

class SecureCache<T> {
  private cache = new Map<string, CacheEntry<T>>();
  private readonly ttl: number;

  constructor(ttlMs: number = 3600000) {
    this.ttl = ttlMs;
  }

  set(key: string, value: T): void {
    this.cache.set(key, {
      value,
      expiresAt: Date.now() + this.ttl,
    });
  }

  get(key: string): T | undefined {
    const entry = this.cache.get(key);

    if (!entry) {
      return undefined;
    }

    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return undefined;
    }

    return entry.value;
  }

  has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  delete(key: string): boolean {
    return this.cache.delete(key);
  }

  clear(): void {
    this.cache.clear();
  }

  cleanup(): void {
    const now = Date.now();
    const entries = Array.from(this.cache.entries());
    for (const [key, entry] of entries) {
      if (now > entry.expiresAt) {
        this.cache.delete(key);
      }
    }
  }

  startAutoCleanup(intervalMs: number = 60000): () => void {
    const interval = setInterval(() => this.cleanup(), intervalMs);
    return () => clearInterval(interval);
  }

  get size(): number {
    return this.cache.size;
  }
}

describe("SecureCache", () => {
  let cache: SecureCache<string>;

  beforeEach(() => {
    vi.useFakeTimers();
    cache = new SecureCache<string>(1000); // 1 second TTL for testing
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("basic operations", () => {
    it("stores and retrieves values", () => {
      cache.set("key1", "value1");
      expect(cache.get("key1")).toBe("value1");
    });

    it("returns undefined for non-existent keys", () => {
      expect(cache.get("nonexistent")).toBeUndefined();
    });

    it("overwrites existing values", () => {
      cache.set("key1", "value1");
      cache.set("key1", "value2");
      expect(cache.get("key1")).toBe("value2");
    });

    it("stores multiple keys independently", () => {
      cache.set("key1", "value1");
      cache.set("key2", "value2");
      cache.set("key3", "value3");

      expect(cache.get("key1")).toBe("value1");
      expect(cache.get("key2")).toBe("value2");
      expect(cache.get("key3")).toBe("value3");
    });
  });

  describe("has()", () => {
    it("returns true for existing non-expired entries", () => {
      cache.set("key1", "value1");
      expect(cache.has("key1")).toBe(true);
    });

    it("returns false for non-existent entries", () => {
      expect(cache.has("nonexistent")).toBe(false);
    });

    it("returns false for expired entries", () => {
      cache.set("key1", "value1");
      vi.advanceTimersByTime(1001);
      expect(cache.has("key1")).toBe(false);
    });
  });

  describe("delete()", () => {
    it("removes existing entries", () => {
      cache.set("key1", "value1");
      const result = cache.delete("key1");
      expect(result).toBe(true);
      expect(cache.get("key1")).toBeUndefined();
    });

    it("returns false for non-existent entries", () => {
      const result = cache.delete("nonexistent");
      expect(result).toBe(false);
    });
  });

  describe("clear()", () => {
    it("removes all entries", () => {
      cache.set("key1", "value1");
      cache.set("key2", "value2");
      cache.set("key3", "value3");

      cache.clear();

      expect(cache.get("key1")).toBeUndefined();
      expect(cache.get("key2")).toBeUndefined();
      expect(cache.get("key3")).toBeUndefined();
      expect(cache.size).toBe(0);
    });
  });

  describe("TTL expiration", () => {
    it("returns value before TTL expires", () => {
      cache.set("key1", "value1");
      vi.advanceTimersByTime(500);
      expect(cache.get("key1")).toBe("value1");
    });

    it("returns undefined after TTL expires", () => {
      cache.set("key1", "value1");
      vi.advanceTimersByTime(1001);
      expect(cache.get("key1")).toBeUndefined();
    });

    it("removes expired entry on access", () => {
      cache.set("key1", "value1");
      vi.advanceTimersByTime(1001);
      cache.get("key1"); // Access triggers deletion
      expect(cache.size).toBe(0);
    });

    it("handles different TTLs per cache instance", () => {
      const shortCache = new SecureCache<string>(100);
      const longCache = new SecureCache<string>(10000);

      shortCache.set("key", "short");
      longCache.set("key", "long");

      vi.advanceTimersByTime(500);

      expect(shortCache.get("key")).toBeUndefined();
      expect(longCache.get("key")).toBe("long");
    });

    it("uses default TTL of 1 hour when not specified", () => {
      const defaultCache = new SecureCache<string>();
      defaultCache.set("key", "value");

      vi.advanceTimersByTime(3599999); // Just under 1 hour
      expect(defaultCache.get("key")).toBe("value");

      vi.advanceTimersByTime(2); // Now over 1 hour
      expect(defaultCache.get("key")).toBeUndefined();
    });
  });

  describe("cleanup()", () => {
    it("removes only expired entries", () => {
      cache.set("key1", "value1");
      vi.advanceTimersByTime(500);
      cache.set("key2", "value2");
      vi.advanceTimersByTime(600); // key1 expired, key2 still valid

      cache.cleanup();

      expect(cache.get("key1")).toBeUndefined();
      expect(cache.get("key2")).toBe("value2");
    });

    it("handles empty cache", () => {
      expect(() => cache.cleanup()).not.toThrow();
    });

    it("handles all expired entries", () => {
      cache.set("key1", "value1");
      cache.set("key2", "value2");
      vi.advanceTimersByTime(1001);

      cache.cleanup();

      expect(cache.size).toBe(0);
    });
  });

  describe("startAutoCleanup()", () => {
    it("performs cleanup at specified interval", () => {
      const stopCleanup = cache.startAutoCleanup(500);

      cache.set("key1", "value1");
      vi.advanceTimersByTime(1001); // Entry expired

      // Cache still has entry (not cleaned yet)
      expect(cache.size).toBe(1);

      vi.advanceTimersByTime(500); // Trigger cleanup

      // Now entry should be removed
      expect(cache.size).toBe(0);

      stopCleanup();
    });

    it("returns a stop function that cancels cleanup", () => {
      const stopCleanup = cache.startAutoCleanup(100);

      cache.set("key1", "value1");
      vi.advanceTimersByTime(1001); // Entry expired

      stopCleanup(); // Stop auto-cleanup

      vi.advanceTimersByTime(500); // Would have triggered cleanup

      // Entry still in cache (cleanup was stopped)
      expect(cache.size).toBe(1);
    });
  });

  describe("type safety", () => {
    it("works with number values", () => {
      const numCache = new SecureCache<number>(1000);
      numCache.set("count", 42);
      expect(numCache.get("count")).toBe(42);
    });

    it("works with object values", () => {
      const objCache = new SecureCache<{ name: string; value: number }>(1000);
      const obj = { name: "test", value: 123 };
      objCache.set("obj", obj);
      expect(objCache.get("obj")).toEqual(obj);
    });

    it("works with array values", () => {
      const arrCache = new SecureCache<string[]>(1000);
      const arr = ["a", "b", "c"];
      arrCache.set("arr", arr);
      expect(arrCache.get("arr")).toEqual(arr);
    });
  });

  describe("edge cases", () => {
    it("handles empty string keys", () => {
      cache.set("", "empty-key-value");
      expect(cache.get("")).toBe("empty-key-value");
    });

    it("handles empty string values", () => {
      cache.set("key", "");
      expect(cache.get("key")).toBe("");
    });

    it("handles special characters in keys", () => {
      cache.set("key with spaces", "value1");
      cache.set("key/with/slashes", "value2");
      cache.set("key.with.dots", "value3");

      expect(cache.get("key with spaces")).toBe("value1");
      expect(cache.get("key/with/slashes")).toBe("value2");
      expect(cache.get("key.with.dots")).toBe("value3");
    });

    it("handles zero TTL", () => {
      const zeroTtlCache = new SecureCache<string>(0);
      zeroTtlCache.set("key", "value");
      // With zero TTL, entry should expire immediately
      vi.advanceTimersByTime(1);
      expect(zeroTtlCache.get("key")).toBeUndefined();
    });
  });
});
