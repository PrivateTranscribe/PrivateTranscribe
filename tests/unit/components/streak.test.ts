/**
 * Tests for streak computation logic (DashboardPage).
 *
 * computeStreak now accepts a Set<string> of "YYYY-MM-DD" date keys sourced
 * directly from the database (via getStreakDates) rather than the paginated
 * in-memory transcription list. This prevents the streak from resetting when
 * the display history window fills up and evicts older entries.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { computeStreak, toLocalDateKey } from "../../../src/components/pages/DashboardPage";

// Build a date key for N days offset from today (negative = past).
function dateKeyOffset(daysOffset: number): string {
  const d = new Date();
  d.setDate(d.getDate() + daysOffset);
  return toLocalDateKey(d);
}

describe("toLocalDateKey", () => {
  it("formats a date as YYYY-MM-DD", () => {
    const d = new Date(2026, 2, 12); // March 12, 2026 (month is 0-indexed)
    expect(toLocalDateKey(d)).toBe("2026-03-12");
  });

  it("zero-pads month and day", () => {
    const d = new Date(2026, 0, 5); // Jan 5
    expect(toLocalDateKey(d)).toBe("2026-01-05");
  });
});

describe("computeStreak", () => {
  it("returns 0 for an empty set", () => {
    expect(computeStreak(new Set())).toBe(0);
  });

  it("returns 1 when only today has activity", () => {
    const dates = new Set([dateKeyOffset(0)]);
    expect(computeStreak(dates)).toBe(1);
  });

  it("returns 1 when only yesterday has activity (grace window)", () => {
    const dates = new Set([dateKeyOffset(-1)]);
    expect(computeStreak(dates)).toBe(1);
  });

  it("returns 0 when only the day before yesterday has activity", () => {
    const dates = new Set([dateKeyOffset(-2)]);
    expect(computeStreak(dates)).toBe(0);
  });

  it("returns 2 for today + yesterday", () => {
    const dates = new Set([dateKeyOffset(0), dateKeyOffset(-1)]);
    expect(computeStreak(dates)).toBe(2);
  });

  it("returns 3 for today + yesterday + 2 days ago", () => {
    const dates = new Set([dateKeyOffset(0), dateKeyOffset(-1), dateKeyOffset(-2)]);
    expect(computeStreak(dates)).toBe(3);
  });

  it("stops counting when there is a gap", () => {
    // today and 2 days ago but NOT yesterday — streak anchors today, breaks at yesterday
    const dates = new Set([dateKeyOffset(0), dateKeyOffset(-2)]);
    expect(computeStreak(dates)).toBe(1);
  });

  it("grace window: yesterday + 2 days ago = streak 2", () => {
    const dates = new Set([dateKeyOffset(-1), dateKeyOffset(-2)]);
    expect(computeStreak(dates)).toBe(2);
  });

  it("grace window: gap stops counting", () => {
    // yesterday and 3 days ago but NOT 2 days ago
    const dates = new Set([dateKeyOffset(-1), dateKeyOffset(-3)]);
    expect(computeStreak(dates)).toBe(1);
  });

  it("ignores future dates when computing streak", () => {
    // A future date should not extend the streak — anchor is today or yesterday
    const dates = new Set([dateKeyOffset(0), dateKeyOffset(1)]);
    // today is in the set, anchor = today; loop goes today → yesterday (not in set) → break
    expect(computeStreak(dates)).toBe(1);
  });

  it("handles a long consecutive streak correctly", () => {
    const dates = new Set<string>();
    for (let i = 0; i < 30; i++) {
      dates.add(dateKeyOffset(-i));
    }
    expect(computeStreak(dates)).toBe(30);
  });

  // Regression: streak must NOT reset when the paginated history window fills up.
  // Previously computeStreak operated on the in-memory TranscriptionItem list which
  // was capped at currentLimit (default 50). Adding many transcriptions today could
  // evict yesterday's entry, causing the streak to drop from 2 → 1.
  it("regression: streak stays at 2 even if yesterday has only 1 entry vs 50 today", () => {
    // Simulate: the DB returns BOTH days regardless of how many items today has.
    const dates = new Set([dateKeyOffset(0), dateKeyOffset(-1)]);
    // Should always be 2 — the date set is not size-capped.
    expect(computeStreak(dates)).toBe(2);
  });

  it("regression: streak stays at 3 with many days when full history loaded from DB", () => {
    const dates = new Set([dateKeyOffset(0), dateKeyOffset(-1), dateKeyOffset(-2)]);
    expect(computeStreak(dates)).toBe(3);
  });
});
