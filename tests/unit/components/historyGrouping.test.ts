/**
 * Tests for date grouping helpers in HistoryPage.
 *
 * getDateGroup classifies a timestamp string into one of:
 *   "Today" | "Yesterday" | "This Week" | "Older"
 *
 * groupTranscriptions groups an array of items into ordered buckets,
 * omitting empty groups.
 *
 * Both helpers are pure functions exported for testing.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  getDateGroup,
  groupTranscriptions,
} from "../../../src/components/pages/HistoryPage";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build an ISO timestamp string for a date offset in days from today */
function isoOffset(daysOffset: number): string {
  const d = new Date();
  d.setDate(d.getDate() + daysOffset);
  // Use noon to avoid DST boundary issues
  d.setHours(12, 0, 0, 0);
  return d.toISOString();
}

/** Minimal TranscriptionItem stub */
function item(id: string, timestamp: string) {
  return { id, timestamp, text: "test", language: "en", duration: 1, wordCount: 1 } as any;
}

// ---------------------------------------------------------------------------
// getDateGroup
// ---------------------------------------------------------------------------

describe("getDateGroup", () => {
  it("classifies today's timestamp as Today", () => {
    expect(getDateGroup(isoOffset(0))).toBe("Today");
  });

  it("classifies yesterday's timestamp as Yesterday", () => {
    expect(getDateGroup(isoOffset(-1))).toBe("Yesterday");
  });

  it("classifies 2 days ago as This Week", () => {
    expect(getDateGroup(isoOffset(-2))).toBe("This Week");
  });

  it("classifies 6 days ago as This Week (boundary)", () => {
    expect(getDateGroup(isoOffset(-6))).toBe("This Week");
  });

  it("classifies 7 days ago as Older", () => {
    expect(getDateGroup(isoOffset(-7))).toBe("Older");
  });

  it("classifies 30 days ago as Older", () => {
    expect(getDateGroup(isoOffset(-30))).toBe("Older");
  });

  it("appends Z when timestamp lacks it", () => {
    // Construct a naive UTC string without trailing Z
    const d = new Date();
    d.setHours(12, 0, 0, 0);
    const noZ = d.toISOString().replace("Z", "");
    // Should still resolve to Today (not NaN → Older)
    expect(getDateGroup(noZ)).toBe("Today");
  });

  it("classifies invalid timestamp as Older (not a crash)", () => {
    expect(getDateGroup("not-a-date")).toBe("Older");
  });

  it("classifies empty string as Older (not a crash)", () => {
    expect(getDateGroup("")).toBe("Older");
  });
});

// ---------------------------------------------------------------------------
// groupTranscriptions
// ---------------------------------------------------------------------------

describe("groupTranscriptions", () => {
  it("returns an empty array for an empty input", () => {
    expect(groupTranscriptions([])).toEqual([]);
  });

  it("groups a single today item into Today bucket", () => {
    const items = [item("a", isoOffset(0))];
    const groups = groupTranscriptions(items);
    expect(groups).toHaveLength(1);
    expect(groups[0].label).toBe("Today");
    expect(groups[0].items).toHaveLength(1);
  });

  it("groups items across multiple buckets and orders them correctly", () => {
    const items = [
      item("old", isoOffset(-30)),
      item("yesterday", isoOffset(-1)),
      item("today", isoOffset(0)),
      item("week", isoOffset(-4)),
    ];
    const groups = groupTranscriptions(items);
    const labels = groups.map((g) => g.label);
    // ORDER: Today → Yesterday → This Week → Older
    expect(labels).toEqual(["Today", "Yesterday", "This Week", "Older"]);
  });

  it("omits empty buckets (no Yesterday item → no Yesterday group)", () => {
    const items = [
      item("today", isoOffset(0)),
      item("old", isoOffset(-30)),
    ];
    const groups = groupTranscriptions(items);
    const labels = groups.map((g) => g.label);
    expect(labels).not.toContain("Yesterday");
    expect(labels).not.toContain("This Week");
    expect(labels).toContain("Today");
    expect(labels).toContain("Older");
  });

  it("multiple items in the same bucket are all preserved", () => {
    const items = [
      item("t1", isoOffset(0)),
      item("t2", isoOffset(0)),
      item("t3", isoOffset(0)),
    ];
    const groups = groupTranscriptions(items);
    expect(groups).toHaveLength(1);
    expect(groups[0].items).toHaveLength(3);
  });

  it("invalid timestamps land in Older, not a crash", () => {
    const items = [item("bad", "not-a-date")];
    const groups = groupTranscriptions(items);
    expect(groups).toHaveLength(1);
    expect(groups[0].label).toBe("Older");
  });
});
