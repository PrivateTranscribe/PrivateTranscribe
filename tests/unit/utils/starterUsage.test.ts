import { describe, expect, it, vi } from "vitest";

import {
  STARTER_DAILY_WORD_LIMIT,
  countWords,
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
