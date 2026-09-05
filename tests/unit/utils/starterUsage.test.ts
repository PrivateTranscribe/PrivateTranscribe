import { describe, expect, it, vi } from "vitest";

import {
  STARTER_DAILY_WORD_LIMIT,
  countWords,
  formatTimeUntilLocalMidnight,
  isStarterLimitReached,
  readStarterUsage,
  recordStarterWords,
} from "../../../src/utils/starterUsage";

function createStorage(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  return {
    getItem: vi.fn((key: string) => store.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => store.set(key, String(value))),
    removeItem: vi.fn((key: string) => store.delete(key)),
  };
}

describe("starterUsage", () => {
  it("defaults Starter to a 1,000 word daily cap", () => {
    const storage = createStorage();

    expect(STARTER_DAILY_WORD_LIMIT).toBe(1000);
    expect(readStarterUsage(storage, new Date("2026-06-26T08:00:00"))).toMatchObject({
      limit: 1000,
      wordsUsed: 0,
    });
  });

  it("applies the current cap to existing installs with an old stored limit", () => {
    const storage = createStorage({
      privatetranscribe_starter_usage_v1: JSON.stringify({
        date: "2026-06-26",
        wordsUsed: 800,
        limit: 5000,
      }),
    });

    expect(readStarterUsage(storage, new Date("2026-06-26T10:00:00"))).toEqual({
      date: "2026-06-26",
      wordsUsed: 800,
      limit: 1000,
    });
    expect(isStarterLimitReached(storage, new Date("2026-06-26T10:00:00"))).toBe(false);
  });

  it("counts words without storing transcript content", () => {
    expect(countWords(" Talk to Claude Code, then fix tests. ")).toBe(7);
    expect(countWords("")).toBe(0);
  });

  it("resets usage by local day", () => {
    const storage = createStorage({
      privatetranscribe_starter_usage_v1: JSON.stringify({
        date: "2026-06-25",
        wordsUsed: 1900,
        limit: STARTER_DAILY_WORD_LIMIT,
      }),
    });

    expect(readStarterUsage(storage, new Date("2026-06-26T08:00:00"))).toEqual({
      date: "2026-06-26",
      wordsUsed: 0,
      limit: STARTER_DAILY_WORD_LIMIT,
    });
  });

  it("formats the remaining time until the next local midnight", () => {
    expect(formatTimeUntilLocalMidnight(new Date(2026, 6, 13, 16, 30, 0))).toBe("7h 30m");
    expect(formatTimeUntilLocalMidnight(new Date(2026, 6, 13, 23, 45, 0))).toBe("15m");
    expect(formatTimeUntilLocalMidnight(new Date(2026, 6, 13, 23, 59, 30))).toBe("1m");
  });

  it("records only aggregate word counts", () => {
    const storage = createStorage();
    const result = recordStarterWords(
      "This transcript should never be persisted by usage tracking",
      storage,
      new Date("2026-06-26T08:00:00")
    );

    expect(result.wordsAdded).toBe(9);
    expect(result.wordsUsed).toBe(9);
    expect(storage.setItem).toHaveBeenCalledOnce();
    const stored = String(storage.setItem.mock.calls[0][1]);
    expect(stored).not.toContain("transcript");
    expect(stored).not.toContain("persisted");
  });

  it("marks the starter limit as reached after the daily budget is used", () => {
    const storage = createStorage();
    recordStarterWords(
      "word ".repeat(STARTER_DAILY_WORD_LIMIT),
      storage,
      new Date("2026-06-26T08:00:00")
    );

    expect(isStarterLimitReached(storage, new Date("2026-06-26T09:00:00"))).toBe(true);
  });
});
