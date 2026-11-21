import { describe, expect, it } from "vitest";
import {
  classifyCleanupFailure,
  getCleanupFailureNotice,
} from "../../../src/utils/cleanupFailureNotice";

describe("classifyCleanupFailure", () => {
  it.each([
    [Object.assign(new Error("Unauthorized"), { status: 401 }), "auth"],
    [new Error("Anthropic API error: invalid x-api-key"), "auth"],
    [new Error("Anthropic API key not configured"), "not_set_up"],
    [Object.assign(new Error("Slow down"), { status: 429 }), "rate_limit"],
    [new Error("You exceeded your current quota"), "rate_limit"],
    [new Error("AI cleanup timed out after 21000 ms"), "timeout"],
    [new TypeError("Failed to fetch"), "network"],
    [new Error("getaddrinfo ENOTFOUND api.openai.com"), "network"],
    [new Error("Gemini returned empty response"), "other"],
  ])("files %s as %s", (error, kind) => {
    expect(classifyCleanupFailure(error)).toBe(kind);
  });

  it("files a cancelled cleanup as nothing to tell", () => {
    expect(classifyCleanupFailure(new Error("AI cleanup cancelled"))).toBeNull();
    expect(classifyCleanupFailure(new Error("Already processing a request"))).toBeNull();
    expect(
      classifyCleanupFailure(Object.assign(new Error("x"), { name: "AbortError" }))
    ).toBeNull();
  });
});

describe("getCleanupFailureNotice", () => {
  it("names the provider and what to do", () => {
    expect(getCleanupFailureNotice("not_set_up", "groq").description).toBe(
      "Groq has no API key. Add one in AI Enhancement."
    );
    expect(getCleanupFailureNotice("not_set_up", "local").description).toBe(
      "The local AI model is not ready. Download it in AI Enhancement."
    );
    expect(getCleanupFailureNotice("network", "custom").description).toBe(
      "Could not reach your custom endpoint. Check your connection."
    );
  });
});
