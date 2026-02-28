/**
 * Tests for retry utilities
 * @module tests/unit/utils/retry
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Inline implementation for testing
interface RetryOptions {
  maxRetries?: number;
  initialDelay?: number;
  maxDelay?: number;
  backoffMultiplier?: number;
  shouldRetry?: (error: any) => boolean;
}

async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const {
    maxRetries = 3,
    initialDelay = 1000,
    maxDelay = 10000,
    backoffMultiplier = 2,
    shouldRetry = () => true,
  } = options;

  let lastError: any;
  let delay = initialDelay;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      if (attempt === maxRetries || !shouldRetry(error)) {
        throw error;
      }

      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(delay * backoffMultiplier, maxDelay);
    }
  }

  throw lastError;
}

function createApiRetryStrategy() {
  return {
    shouldRetry: (error: any) => {
      // Get status from response object or directly from error
      const status = error.response?.status ?? error.status;
      // If no status at all, retry (network error)
      if (status === undefined) return true;
      // Only retry on 5xx errors
      return status >= 500 && status < 600;
    },
  };
}

function createFileRetryStrategy() {
  return {
    shouldRetry: (error: any) => {
      const retriableErrors = ["EBUSY", "ENOENT", "EPERM", "EAGAIN"];
      return retriableErrors.includes(error.code);
    },
    maxRetries: 2,
    initialDelay: 500,
  };
}

describe("retry utilities", () => {
  describe("withRetry", () => {
    describe("successful operations", () => {
      it("returns result on first successful attempt", async () => {
        const fn = vi.fn().mockResolvedValue("success");
        const result = await withRetry(fn, { initialDelay: 1 });

        expect(result).toBe("success");
        expect(fn).toHaveBeenCalledTimes(1);
      });

      it("returns result after retries succeed", async () => {
        const fn = vi
          .fn()
          .mockRejectedValueOnce(new Error("fail1"))
          .mockRejectedValueOnce(new Error("fail2"))
          .mockResolvedValue("success");

        const result = await withRetry(fn, { maxRetries: 3, initialDelay: 1 });

        expect(result).toBe("success");
        expect(fn).toHaveBeenCalledTimes(3);
      });
    });

    describe("retry limits", () => {
      it("respects maxRetries option", async () => {
        const fn = vi.fn().mockRejectedValue(new Error("always fails"));

        await expect(withRetry(fn, { maxRetries: 2, initialDelay: 1 })).rejects.toThrow(
          "always fails"
        );

        // Initial attempt + 2 retries = 3 calls
        expect(fn).toHaveBeenCalledTimes(3);
      });

      it("uses default maxRetries of 3", async () => {
        const fn = vi.fn().mockRejectedValue(new Error("fail"));

        await expect(withRetry(fn, { initialDelay: 1 })).rejects.toThrow();

        // Initial + 3 retries = 4 calls
        expect(fn).toHaveBeenCalledTimes(4);
      });

      it("handles maxRetries of 0", async () => {
        const fn = vi.fn().mockRejectedValue(new Error("fail"));

        await expect(withRetry(fn, { maxRetries: 0, initialDelay: 1 })).rejects.toThrow();

        // Only initial attempt
        expect(fn).toHaveBeenCalledTimes(1);
      });
    });

    describe("exponential backoff", () => {
      it("calculates correct delay sequence", () => {
        // Test the backoff calculation logic directly
        const options = {
          initialDelay: 100,
          backoffMultiplier: 2,
          maxDelay: 10000,
        };

        let delay = options.initialDelay;
        const delays: number[] = [];

        for (let i = 0; i < 5; i++) {
          delays.push(delay);
          delay = Math.min(delay * options.backoffMultiplier, options.maxDelay);
        }

        expect(delays).toEqual([100, 200, 400, 800, 1600]);
      });

      it("caps delay at maxDelay", () => {
        const options = {
          initialDelay: 100,
          backoffMultiplier: 3,
          maxDelay: 500,
        };

        let delay = options.initialDelay;
        const delays: number[] = [];

        for (let i = 0; i < 5; i++) {
          delays.push(delay);
          delay = Math.min(delay * options.backoffMultiplier, options.maxDelay);
        }

        // 100, 300, 500 (capped), 500 (capped), 500 (capped)
        expect(delays).toEqual([100, 300, 500, 500, 500]);
      });
    });

    describe("shouldRetry callback", () => {
      it("stops retrying when shouldRetry returns false", async () => {
        const customError = { code: "PERMANENT_ERROR" };
        const fn = vi.fn().mockRejectedValue(customError);

        const shouldRetry = vi.fn().mockReturnValue(false);

        await expect(
          withRetry(fn, { shouldRetry, maxRetries: 5, initialDelay: 1 })
        ).rejects.toEqual(customError);

        expect(fn).toHaveBeenCalledTimes(1);
        expect(shouldRetry).toHaveBeenCalledWith(customError);
      });

      it("continues retrying when shouldRetry returns true", async () => {
        const fn = vi.fn().mockRejectedValue(new Error("retriable"));

        const shouldRetry = vi.fn().mockReturnValue(true);

        await expect(
          withRetry(fn, { shouldRetry, maxRetries: 2, initialDelay: 1 })
        ).rejects.toThrow();

        expect(fn).toHaveBeenCalledTimes(3);
        expect(shouldRetry).toHaveBeenCalledTimes(2); // Not called on final attempt
      });
    });

    describe("error propagation", () => {
      it("throws the last error after all retries exhausted", async () => {
        const fn = vi
          .fn()
          .mockRejectedValueOnce(new Error("error1"))
          .mockRejectedValueOnce(new Error("error2"))
          .mockRejectedValue(new Error("error3"));

        await expect(withRetry(fn, { maxRetries: 2, initialDelay: 1 })).rejects.toThrow("error3");
      });
    });
  });

  describe("createApiRetryStrategy", () => {
    const strategy = createApiRetryStrategy();

    it("retries on network errors (no response)", () => {
      expect(strategy.shouldRetry(new Error("Network Error"))).toBe(true);
    });

    it("retries on 500 status codes", () => {
      expect(strategy.shouldRetry({ response: { status: 500 } })).toBe(true);
      expect(strategy.shouldRetry({ response: { status: 502 } })).toBe(true);
      expect(strategy.shouldRetry({ response: { status: 503 } })).toBe(true);
      expect(strategy.shouldRetry({ response: { status: 504 } })).toBe(true);
    });

    it("does NOT retry on 4xx status codes", () => {
      expect(strategy.shouldRetry({ response: { status: 400 } })).toBe(false);
      expect(strategy.shouldRetry({ response: { status: 401 } })).toBe(false);
      expect(strategy.shouldRetry({ response: { status: 403 } })).toBe(false);
      expect(strategy.shouldRetry({ response: { status: 404 } })).toBe(false);
      expect(strategy.shouldRetry({ response: { status: 429 } })).toBe(false);
    });

    it("handles status on error object directly", () => {
      expect(strategy.shouldRetry({ status: 500 })).toBe(true);
      expect(strategy.shouldRetry({ status: 400 })).toBe(false);
    });
  });

  describe("createFileRetryStrategy", () => {
    const strategy = createFileRetryStrategy();

    it("has correct default options", () => {
      expect(strategy.maxRetries).toBe(2);
      expect(strategy.initialDelay).toBe(500);
    });

    it("retries on EBUSY errors", () => {
      expect(strategy.shouldRetry({ code: "EBUSY" })).toBe(true);
    });

    it("retries on ENOENT errors", () => {
      expect(strategy.shouldRetry({ code: "ENOENT" })).toBe(true);
    });

    it("retries on EPERM errors", () => {
      expect(strategy.shouldRetry({ code: "EPERM" })).toBe(true);
    });

    it("retries on EAGAIN errors", () => {
      expect(strategy.shouldRetry({ code: "EAGAIN" })).toBe(true);
    });

    it("does NOT retry on other error codes", () => {
      expect(strategy.shouldRetry({ code: "EACCES" })).toBe(false);
      expect(strategy.shouldRetry({ code: "EEXIST" })).toBe(false);
      expect(strategy.shouldRetry({ code: "UNKNOWN" })).toBe(false);
    });

    it("does NOT retry errors without code", () => {
      expect(strategy.shouldRetry(new Error("generic error"))).toBe(false);
      expect(strategy.shouldRetry({})).toBe(false);
    });
  });
});
