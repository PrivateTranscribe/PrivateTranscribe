import { describe, expect, it, vi } from "vitest";
import { createApiRetryStrategy, withRetry } from "../../../src/utils/retry";

describe("retry utilities", () => {
  describe("withRetry", () => {
    it("returns result on first successful attempt", async () => {
      const fn = vi.fn().mockResolvedValue("success");

      await expect(withRetry(fn, { initialDelay: 1 })).resolves.toBe("success");
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it("returns result after retries succeed", async () => {
      const fn = vi
        .fn()
        .mockRejectedValueOnce(new Error("fail1"))
        .mockRejectedValueOnce(new Error("fail2"))
        .mockResolvedValue("success");

      await expect(withRetry(fn, { maxRetries: 3, initialDelay: 1 })).resolves.toBe("success");
      expect(fn).toHaveBeenCalledTimes(3);
    });

    it("respects maxRetries", async () => {
      const fn = vi.fn().mockRejectedValue(new Error("always fails"));

      await expect(withRetry(fn, { maxRetries: 2, initialDelay: 1 })).rejects.toThrow(
        "always fails"
      );
      expect(fn).toHaveBeenCalledTimes(3);
    });

    it("stops retrying when shouldRetry returns false", async () => {
      const customError = { code: "PERMANENT_ERROR" };
      const fn = vi.fn().mockRejectedValue(customError);
      const shouldRetry = vi.fn().mockReturnValue(false);

      await expect(withRetry(fn, { shouldRetry, maxRetries: 5, initialDelay: 1 })).rejects.toEqual(
        customError
      );
      expect(fn).toHaveBeenCalledTimes(1);
      expect(shouldRetry).toHaveBeenCalledWith(customError);
    });
  });

  describe("createApiRetryStrategy", () => {
    const strategy = createApiRetryStrategy();

    it("retries on network errors and 5xx status codes", () => {
      expect(strategy.shouldRetry(new Error("Network Error"))).toBe(true);
      expect(strategy.shouldRetry({ response: { status: 500 } })).toBe(true);
      expect(strategy.shouldRetry({ response: { status: 504 } })).toBe(true);
    });

    it("does not retry on 4xx status codes", () => {
      expect(strategy.shouldRetry({ response: { status: 400 } })).toBe(false);
      expect(strategy.shouldRetry({ response: { status: 401 } })).toBe(false);
      expect(strategy.shouldRetry({ response: { status: 404 } })).toBe(false);
    });
  });
});
