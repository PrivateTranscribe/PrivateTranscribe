import { describe, expect, it, vi } from "vitest";

import {
  AGENT_MODE_DAILY_USE_LIMIT,
  buildAgentModeLimitMessage,
  isAgentModeLimitReached,
  readAgentModeUsage,
  recordAgentModeUse,
} from "../../../src/utils/agentModeUsage";

function createStorage(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  return {
    getItem: vi.fn((key: string) => store.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => store.set(key, String(value))),
    removeItem: vi.fn((key: string) => store.delete(key)),
  };
}

describe("agentModeUsage", () => {
  it("defaults Agent Mode to a 20 use daily cap", () => {
    const storage = createStorage();

    expect(AGENT_MODE_DAILY_USE_LIMIT).toBe(20);
    expect(readAgentModeUsage(storage, new Date("2026-06-26T08:00:00"))).toEqual({
      date: "2026-06-26",
      usesToday: 0,
      limit: 20,
    });
  });

  it("applies the current cap to existing installs with an old stored limit", () => {
    const storage = createStorage({
      privatetranscribe_agent_mode_usage_v1: JSON.stringify({
        date: "2026-06-26",
        usesToday: 5,
        limit: 50,
      }),
    });

    expect(readAgentModeUsage(storage, new Date("2026-06-26T10:00:00"))).toEqual({
      date: "2026-06-26",
      usesToday: 5,
      limit: 20,
    });
    expect(isAgentModeLimitReached(storage, new Date("2026-06-26T10:00:00"))).toBe(false);
  });

  it("resets usage by local day", () => {
    const storage = createStorage({
      privatetranscribe_agent_mode_usage_v1: JSON.stringify({
        date: "2026-06-25",
        usesToday: 20,
        limit: AGENT_MODE_DAILY_USE_LIMIT,
      }),
    });

    expect(readAgentModeUsage(storage, new Date("2026-06-26T08:00:00"))).toEqual({
      date: "2026-06-26",
      usesToday: 0,
      limit: AGENT_MODE_DAILY_USE_LIMIT,
    });
  });

  it("increments usage and reports remaining and limitReached", () => {
    const storage = createStorage();
    const date = new Date("2026-06-26T08:00:00");

    const first = recordAgentModeUse(storage, date);
    expect(first).toEqual({
      date: "2026-06-26",
      usesToday: 1,
      limit: 20,
      remaining: 19,
      limitReached: false,
    });

    for (let i = 1; i < 19; i++) {
      recordAgentModeUse(storage, date);
    }
    expect(isAgentModeLimitReached(storage, date)).toBe(false);

    const twentieth = recordAgentModeUse(storage, date);
    expect(twentieth.usesToday).toBe(20);
    expect(twentieth.remaining).toBe(0);
    expect(twentieth.limitReached).toBe(true);
    expect(isAgentModeLimitReached(storage, date)).toBe(true);
  });

  it("reads corrupt JSON as fresh usage without throwing", () => {
    const storage = createStorage({
      privatetranscribe_agent_mode_usage_v1: "{not valid json",
    });

    expect(() => readAgentModeUsage(storage, new Date("2026-06-26T08:00:00"))).not.toThrow();
    expect(readAgentModeUsage(storage, new Date("2026-06-26T08:00:00"))).toEqual({
      date: "2026-06-26",
      usesToday: 0,
      limit: AGENT_MODE_DAILY_USE_LIMIT,
    });
  });

  it("still returns the incremented result when storage.setItem throws", () => {
    const storage = createStorage();
    storage.setItem = vi.fn(() => {
      throw new Error("storage unavailable");
    });
    const date = new Date("2026-06-26T08:00:00");

    expect(() => recordAgentModeUse(storage, date)).not.toThrow();
    const result = recordAgentModeUse(storage, date);
    expect(result).toEqual({
      date: "2026-06-26",
      usesToday: 1,
      limit: 20,
      remaining: 19,
      limitReached: false,
    });
  });

  it("stores only date, usesToday, and limit", () => {
    const storage = createStorage();
    recordAgentModeUse(storage, new Date("2026-06-26T08:00:00"));

    const stored = JSON.parse(String(storage.setItem.mock.calls[0][1]));
    expect(Object.keys(stored).sort()).toEqual(["date", "limit", "usesToday"]);
  });

  it("builds the limit message with and without a usage object", () => {
    expect(buildAgentModeLimitMessage()).toBe(
      "Starter includes 20 Agent Mode prompts a day. It resets tomorrow. Buy Pro for unlimited Agent Mode."
    );
    expect(buildAgentModeLimitMessage({ limit: 50 })).toBe(
      "Starter includes 50 Agent Mode prompts a day. It resets tomorrow. Buy Pro for unlimited Agent Mode."
    );
  });
});
