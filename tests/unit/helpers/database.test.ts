/**
 * Tests for Database Manager
 * @module tests/unit/helpers/database
 *
 * Note: These tests use an in-memory implementation of the database
 * to avoid filesystem and Electron dependencies.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

// In-memory implementation for testing database logic
// This mirrors the behavior of src/helpers/database.js without Electron dependencies

interface Transcription {
  id: number;
  text: string;
  timestamp: string;
  created_at: string;
  include_in_stats: number;
}

interface DictionaryEntry {
  id: number;
  word: string;
  created_at: string;
}

interface CorrectionEntry {
  id: number;
  source: string;
  target: string;
  count: number;
  last_seen_at: string;
  created_at: string;
}

interface Stats {
  id: number;
  total_words: number;
  total_transcriptions: number;
  total_seconds: number;
  average_wpm: number;
  updated_at: string;
}

interface SaveOptions {
  includeInStats?: boolean;
}

class MockDatabaseManager {
  private transcriptions: Transcription[] = [];
  private dictionary: DictionaryEntry[] = [];
  private corrections: CorrectionEntry[] = [];
  private stats: Stats = {
    id: 1,
    total_words: 0,
    total_transcriptions: 0,
    total_seconds: 0,
    average_wpm: 0,
    updated_at: new Date().toISOString(),
  };
  private nextTranscriptionId = 1;
  private nextDictionaryId = 1;
  private nextCorrectionId = 1;

  saveTranscription(
    text: string,
    durationSeconds: number | null = null,
    options: SaveOptions = {}
  ): { id: number; success: boolean; transcription: Transcription } {
    if (!text || typeof text !== "string") {
      throw new Error("Text is required");
    }

    const now = new Date().toISOString();
    const includeInStats = options?.includeInStats !== false;

    const transcription: Transcription = {
      id: this.nextTranscriptionId++,
      text,
      timestamp: now,
      created_at: now,
      include_in_stats: includeInStats ? 1 : 0,
    };

    this.transcriptions.push(transcription);

    if (includeInStats) {
      const wordCount = text.split(/\s+/).filter(Boolean).length;
      const actualSeconds =
        durationSeconds && durationSeconds > 0 ? durationSeconds : (wordCount / 150) * 60;

      this.stats.total_words += wordCount;
      this.stats.total_transcriptions += 1;
      this.stats.total_seconds += actualSeconds;
      this.stats.average_wpm =
        this.stats.total_seconds > 0
          ? this.stats.total_words / (this.stats.total_seconds / 60)
          : 0;
      this.stats.updated_at = now;
    }

    return { id: transcription.id, success: true, transcription };
  }

  getTranscriptions(limit: number = 50): Transcription[] {
    return this.transcriptions
      .slice()
      .sort((a, b) => {
        // Primary sort by timestamp descending, secondary by ID descending
        const timeDiff = new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime();
        if (timeDiff !== 0) return timeDiff;
        return b.id - a.id;
      })
      .slice(0, limit);
  }

  clearTranscriptions(): { cleared: number; success: boolean } {
    const cleared = this.transcriptions.length;
    this.transcriptions = [];
    return { cleared, success: true };
  }

  deleteTranscription(id: number): { success: boolean; id: number } {
    const index = this.transcriptions.findIndex((t) => t.id === id);
    if (index >= 0) {
      this.transcriptions.splice(index, 1);
      return { success: true, id };
    }
    return { success: false, id };
  }

  trimTranscriptions(limit: number): { trimmed: number; success: boolean } {
    if (limit <= 0) {
      const result = this.clearTranscriptions();
      return { trimmed: result.cleared, success: result.success };
    }

    const sorted = this.transcriptions
      .slice()
      .sort((a, b) => {
        // Primary sort by timestamp descending, secondary by ID descending
        const timeDiff = new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime();
        if (timeDiff !== 0) return timeDiff;
        return b.id - a.id;
      });

    const toKeep = sorted.slice(0, limit);
    const trimmed = this.transcriptions.length - toKeep.length;
    this.transcriptions = toKeep;

    return { trimmed, success: true };
  }

  getDictionary(): string[] {
    return this.dictionary.map((d) => d.word);
  }

  setDictionary(words: string[]): { success: boolean } {
    this.dictionary = [];
    this.nextDictionaryId = 1;

    const seen = new Set<string>();
    for (const word of words) {
      const trimmed = typeof word === "string" ? word.trim() : "";
      if (trimmed && !seen.has(trimmed)) {
        seen.add(trimmed);
        this.dictionary.push({
          id: this.nextDictionaryId++,
          word: trimmed,
          created_at: new Date().toISOString(),
        });
      }
    }

    return { success: true };
  }

  getCorrectionMemory(limit: number = 500): CorrectionEntry[] {
    const safeLimit = Math.max(1, Math.min(limit, 5000));
    return this.corrections
      .slice()
      .sort((a, b) => {
        if (b.count !== a.count) return b.count - a.count;
        return new Date(b.last_seen_at).getTime() - new Date(a.last_seen_at).getTime();
      })
      .slice(0, safeLimit);
  }

  upsertCorrection(source: string, target: string): { success: boolean; reason?: string } {
    const src = typeof source === "string" ? source.trim() : "";
    const tgt = typeof target === "string" ? target.trim() : "";

    if (!src || !tgt || src === tgt) {
      return { success: false, reason: "invalid" };
    }

    const existing = this.corrections.find((c) => c.source === src && c.target === tgt);
    const now = new Date().toISOString();

    if (existing) {
      existing.count += 1;
      existing.last_seen_at = now;
    } else {
      this.corrections.push({
        id: this.nextCorrectionId++,
        source: src,
        target: tgt,
        count: 1,
        last_seen_at: now,
        created_at: now,
      });
    }

    return { success: true };
  }

  getStats(): Stats {
    return { ...this.stats };
  }

  private toLocalDateKey(date: Date): string {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  }

  private parseStoredTimestampAsUtc(timestamp: string): Date {
    // Production stores SQLite CURRENT_TIMESTAMP values like "YYYY-MM-DD HH:MM:SS" in UTC.
    // Our tests also allow ISO strings; both should map onto the user's local calendar day.
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(timestamp)) {
      return new Date(timestamp.replace(" ", "T") + "Z");
    }
    return new Date(timestamp);
  }

  getStreakDates(): string[] {
    const distinct = new Set<string>();
    for (const transcription of this.transcriptions) {
      if (transcription.include_in_stats !== 1) continue;
      const parsed = this.parseStoredTimestampAsUtc(transcription.timestamp);
      distinct.add(this.toLocalDateKey(parsed));
    }
    return Array.from(distinct).sort().reverse();
  }

  insertTestTranscription({
    text,
    timestamp,
    includeInStats = true,
  }: {
    text: string;
    timestamp: string;
    includeInStats?: boolean;
  }): void {
    this.transcriptions.push({
      id: this.nextTranscriptionId++,
      text,
      timestamp,
      created_at: timestamp,
      include_in_stats: includeInStats ? 1 : 0,
    });
  }

  // Test helper to reset state
  reset(): void {
    this.transcriptions = [];
    this.dictionary = [];
    this.corrections = [];
    this.stats = {
      id: 1,
      total_words: 0,
      total_transcriptions: 0,
      total_seconds: 0,
      average_wpm: 0,
      updated_at: new Date().toISOString(),
    };
    this.nextTranscriptionId = 1;
    this.nextDictionaryId = 1;
    this.nextCorrectionId = 1;
  }
}

describe("DatabaseManager", () => {
  let db: MockDatabaseManager;

  beforeEach(() => {
    db = new MockDatabaseManager();
  });

  describe("saveTranscription", () => {
    it("saves a transcription and returns the record", () => {
      const result = db.saveTranscription("Hello, world!");

      expect(result.success).toBe(true);
      expect(result.id).toBe(1);
      expect(result.transcription.text).toBe("Hello, world!");
    });

    it("assigns sequential IDs", () => {
      const r1 = db.saveTranscription("First");
      const r2 = db.saveTranscription("Second");
      const r3 = db.saveTranscription("Third");

      expect(r1.id).toBe(1);
      expect(r2.id).toBe(2);
      expect(r3.id).toBe(3);
    });

    it("updates stats by default", () => {
      db.saveTranscription("Hello world test", 5); // 3 words, 5 seconds

      const stats = db.getStats();
      expect(stats.total_words).toBe(3);
      expect(stats.total_transcriptions).toBe(1);
      expect(stats.total_seconds).toBe(5);
    });

    it("skips stats when includeInStats is false", () => {
      db.saveTranscription("Hello world", null, { includeInStats: false });

      const stats = db.getStats();
      expect(stats.total_words).toBe(0);
      expect(stats.total_transcriptions).toBe(0);
    });

    it("estimates duration when not provided", () => {
      db.saveTranscription("One two three four five"); // 5 words

      const stats = db.getStats();
      expect(stats.total_words).toBe(5);
      // Estimated at 150 WPM: 5 words / 150 * 60 = 2 seconds
      expect(stats.total_seconds).toBe(2);
    });

    it("calculates cumulative average WPM", () => {
      db.saveTranscription("One two three", 6); // 3 words in 6 seconds = 30 WPM
      db.saveTranscription("Four five six", 6); // 3 words in 6 seconds = 30 WPM

      const stats = db.getStats();
      expect(stats.total_words).toBe(6);
      expect(stats.total_seconds).toBe(12);
      // Average: 6 words / (12/60) minutes = 30 WPM
      expect(stats.average_wpm).toBe(30);
    });
  });

  describe("getTranscriptions", () => {
    it("returns transcriptions in reverse chronological order", () => {
      db.saveTranscription("First");
      db.saveTranscription("Second");
      db.saveTranscription("Third");

      const results = db.getTranscriptions();

      expect(results.length).toBe(3);
      expect(results[0].text).toBe("Third");
      expect(results[2].text).toBe("First");
    });

    it("respects limit parameter", () => {
      for (let i = 0; i < 10; i++) {
        db.saveTranscription(`Entry ${i}`);
      }

      const results = db.getTranscriptions(5);
      expect(results.length).toBe(5);
    });

    it("returns empty array when no transcriptions exist", () => {
      const results = db.getTranscriptions();
      expect(results).toEqual([]);
    });
  });

  describe("getStreakDates", () => {
    it("returns distinct local-calendar dates for included transcriptions", () => {
      db.insertTestTranscription({ text: "A", timestamp: "2026-03-17 08:00:00" });
      db.insertTestTranscription({ text: "B", timestamp: "2026-03-17 09:00:00" });
      db.insertTestTranscription({ text: "C", timestamp: "2026-03-16 09:00:00" });

      expect(db.getStreakDates()).toEqual(["2026-03-17", "2026-03-16"]);
    });

    it("converts UTC timestamps to local dates so just-after-midnight sessions count for the new day", () => {
      const timezoneOffsetMinutes = new Date().getTimezoneOffset();
      if (timezoneOffsetMinutes === 0) {
        // In UTC this boundary bug cannot be reproduced because UTC and local dates match.
        return;
      }

      // 23:30 UTC and 00:30 UTC on consecutive UTC days. In UTC+1 (e.g. Copenhagen in winter)
      // these land on different local dates even though the raw UTC date extraction would be
      // 2026-03-16 and 2026-03-17. The test computes expected local dates dynamically so it also
      // stays valid in DST-aware environments.
      db.insertTestTranscription({ text: "late night", timestamp: "2026-03-16 23:30:00" });
      db.insertTestTranscription({ text: "after midnight", timestamp: "2026-03-17 00:30:00" });

      const expected = [
        new Date("2026-03-17T00:30:00Z"),
        new Date("2026-03-16T23:30:00Z"),
      ]
        .map((d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`)
        .filter((value, index, arr) => arr.indexOf(value) === index)
        .sort()
        .reverse();

      expect(db.getStreakDates()).toEqual(expected);
    });

    it("ignores transcriptions excluded from stats", () => {
      db.insertTestTranscription({ text: "count me", timestamp: "2026-03-17 08:00:00" });
      db.insertTestTranscription({
        text: "skip me",
        timestamp: "2026-03-16 08:00:00",
        includeInStats: false,
      });

      expect(db.getStreakDates()).toEqual(["2026-03-17"]);
    });
  });

  describe("deleteTranscription", () => {
    it("deletes existing transcription", () => {
      db.saveTranscription("First");
      const { id } = db.saveTranscription("Second");
      db.saveTranscription("Third");

      const result = db.deleteTranscription(id);

      expect(result.success).toBe(true);
      expect(db.getTranscriptions().length).toBe(2);
      expect(db.getTranscriptions().find((t) => t.id === id)).toBeUndefined();
    });

    it("returns failure for non-existent ID", () => {
      const result = db.deleteTranscription(999);
      expect(result.success).toBe(false);
    });
  });

  describe("clearTranscriptions", () => {
    it("removes all transcriptions", () => {
      db.saveTranscription("First");
      db.saveTranscription("Second");
      db.saveTranscription("Third");

      const result = db.clearTranscriptions();

      expect(result.success).toBe(true);
      expect(result.cleared).toBe(3);
      expect(db.getTranscriptions()).toEqual([]);
    });

    it("returns 0 cleared when empty", () => {
      const result = db.clearTranscriptions();
      expect(result.cleared).toBe(0);
    });
  });

  describe("trimTranscriptions", () => {
    it("keeps only the newest entries up to limit", () => {
      for (let i = 1; i <= 10; i++) {
        db.saveTranscription(`Entry ${i}`);
      }

      const result = db.trimTranscriptions(3);

      expect(result.success).toBe(true);
      expect(result.trimmed).toBe(7);
      expect(db.getTranscriptions().length).toBe(3);
      expect(db.getTranscriptions()[0].text).toBe("Entry 10");
    });

    it("clears all when limit is 0", () => {
      db.saveTranscription("Entry 1");
      db.saveTranscription("Entry 2");

      const result = db.trimTranscriptions(0);

      expect(result.trimmed).toBe(2);
      expect(db.getTranscriptions()).toEqual([]);
    });

    it("does nothing when fewer entries than limit", () => {
      db.saveTranscription("Entry 1");
      db.saveTranscription("Entry 2");

      const result = db.trimTranscriptions(10);

      expect(result.trimmed).toBe(0);
      expect(db.getTranscriptions().length).toBe(2);
    });
  });

  describe("getDictionary / setDictionary", () => {
    it("sets and retrieves dictionary words", () => {
      db.setDictionary(["word1", "word2", "word3"]);

      const words = db.getDictionary();
      expect(words).toEqual(["word1", "word2", "word3"]);
    });

    it("trims whitespace from words", () => {
      db.setDictionary(["  spaced  ", "\ttabbed\t", "\nnewlined\n"]);

      const words = db.getDictionary();
      expect(words).toEqual(["spaced", "tabbed", "newlined"]);
    });

    it("filters out empty strings", () => {
      db.setDictionary(["valid", "", "  ", "also-valid"]);

      const words = db.getDictionary();
      expect(words).toEqual(["valid", "also-valid"]);
    });

    it("removes duplicates", () => {
      db.setDictionary(["word", "word", "other", "word"]);

      const words = db.getDictionary();
      expect(words).toEqual(["word", "other"]);
    });

    it("replaces existing dictionary", () => {
      db.setDictionary(["old1", "old2"]);
      db.setDictionary(["new1", "new2", "new3"]);

      const words = db.getDictionary();
      expect(words).toEqual(["new1", "new2", "new3"]);
    });

    it("handles non-string values", () => {
      db.setDictionary([123 as unknown as string, "valid", null as unknown as string]);

      const words = db.getDictionary();
      expect(words).toEqual(["valid"]);
    });
  });

  describe("getCorrectionMemory / upsertCorrection", () => {
    it("stores new corrections", () => {
      db.upsertCorrection("wierd", "weird");
      db.upsertCorrection("recieve", "receive");

      const corrections = db.getCorrectionMemory();
      expect(corrections.length).toBe(2);
    });

    it("increments count for existing corrections", () => {
      db.upsertCorrection("wierd", "weird");
      db.upsertCorrection("wierd", "weird");
      db.upsertCorrection("wierd", "weird");

      const corrections = db.getCorrectionMemory();
      expect(corrections.length).toBe(1);
      expect(corrections[0].count).toBe(3);
    });

    it("sorts by count descending", () => {
      db.upsertCorrection("a", "A");
      db.upsertCorrection("b", "B");
      db.upsertCorrection("b", "B");
      db.upsertCorrection("b", "B");
      db.upsertCorrection("c", "C");
      db.upsertCorrection("c", "C");

      const corrections = db.getCorrectionMemory();
      expect(corrections[0].source).toBe("b");
      expect(corrections[1].source).toBe("c");
      expect(corrections[2].source).toBe("a");
    });

    it("rejects invalid corrections", () => {
      expect(db.upsertCorrection("", "target").success).toBe(false);
      expect(db.upsertCorrection("source", "").success).toBe(false);
      expect(db.upsertCorrection("same", "same").success).toBe(false);
    });

    it("trims source and target", () => {
      db.upsertCorrection("  spaced  ", "  target  ");

      const corrections = db.getCorrectionMemory();
      expect(corrections[0].source).toBe("spaced");
      expect(corrections[0].target).toBe("target");
    });

    it("respects limit parameter", () => {
      for (let i = 0; i < 10; i++) {
        db.upsertCorrection(`source${i}`, `target${i}`);
      }

      const corrections = db.getCorrectionMemory(5);
      expect(corrections.length).toBe(5);
    });

    it("clamps limit to safe range", () => {
      db.upsertCorrection("a", "b");

      // Very high limit should be clamped
      const corrections = db.getCorrectionMemory(10000);
      expect(corrections.length).toBe(1);
    });
  });

  describe("getStats", () => {
    it("returns initial stats", () => {
      const stats = db.getStats();

      expect(stats.total_words).toBe(0);
      expect(stats.total_transcriptions).toBe(0);
      expect(stats.total_seconds).toBe(0);
      expect(stats.average_wpm).toBe(0);
    });

    it("returns accumulated stats after transcriptions", () => {
      db.saveTranscription("one two three", 60); // 3 words in 60 seconds
      db.saveTranscription("four five", 30); // 2 words in 30 seconds

      const stats = db.getStats();

      expect(stats.total_words).toBe(5);
      expect(stats.total_transcriptions).toBe(2);
      expect(stats.total_seconds).toBe(90);
      // 5 words / (90/60) minutes = 3.33 WPM
      expect(stats.average_wpm).toBeCloseTo(3.33, 1);
    });
  });
});
