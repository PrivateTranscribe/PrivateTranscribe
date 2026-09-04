import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";
import {
  DEFAULT_KOKORO_VOICE_ID,
  KOKORO_ACCENTS,
  KOKORO_VOICES,
  SORTED_KOKORO_VOICES,
  VOICE_STORAGE_KEY,
  describeVoice,
  findVoice,
  resolveVoiceId,
} from "../../../src/models/kokoroVoices";

/**
 * The voice table is hand-maintained metadata copied out of kokoro-js. The one
 * failure mode that matters is drift: an upgrade renames or drops a voice, the
 * picker keeps offering it, and the user gets a thrown error from `generate()`
 * instead of audio. So the ids are checked against the .bin files actually
 * shipped in the installed package rather than against another copy of the
 * table.
 */

const VOICES_DIR = path.resolve(__dirname, "../../../node_modules/kokoro-js/voices");

describe("KOKORO_VOICES", () => {
  it("has exactly the 28 English voices", () => {
    expect(KOKORO_VOICES).toHaveLength(28);
  });

  it("has unique ids", () => {
    const ids = KOKORO_VOICES.map((v) => v.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("only lists a/b (American/British) prefixes, matching the accent", () => {
    for (const v of KOKORO_VOICES) {
      const prefix = v.id.charAt(0);
      expect(["a", "b"], `${v.id} has an unexpected language prefix`).toContain(prefix);
      expect(v.accent, `${v.id} accent disagrees with its prefix`).toBe(
        prefix === "a" ? "American" : "British"
      );
      // Second letter is the gender in kokoro's own naming scheme.
      expect(v.gender, `${v.id} gender disagrees with its id`).toBe(
        v.id.charAt(1) === "f" ? "Female" : "Male"
      );
    }
  });

  it("names a default that is in the table", () => {
    expect(findVoice(DEFAULT_KOKORO_VOICE_ID)).toBeDefined();
  });

  it("has a voice file in the installed kokoro-js for every id", () => {
    if (!fs.existsSync(VOICES_DIR)) {
      console.warn(`[kokoroVoices] ${VOICES_DIR} is absent - skipping the package cross-check`);
      return;
    }

    const missing = KOKORO_VOICES.filter(
      (v) => !fs.existsSync(path.join(VOICES_DIR, `${v.id}.bin`))
    ).map((v) => v.id);

    expect(missing, "voice ids with no .bin in kokoro-js").toEqual([]);
  });
});

describe("SORTED_KOKORO_VOICES", () => {
  // The picker shows kokoro-js's own table order: Kristian rejected ordering by
  // the package's grades as subjective, and the grades themselves are gone.
  it("is the table verbatim", () => {
    expect(SORTED_KOKORO_VOICES.map((v) => v.id)).toEqual(KOKORO_VOICES.map((v) => v.id));
  });

  it("returns every voice exactly once", () => {
    expect(SORTED_KOKORO_VOICES).toHaveLength(KOKORO_VOICES.length);
    expect(new Set(SORTED_KOKORO_VOICES.map((v) => v.id)).size).toBe(KOKORO_VOICES.length);
  });

  // The picker draws one sticky heading per accent over a flat list, so a table
  // that interleaved the accents would put voices under the wrong heading.
  it("keeps each accent in one unbroken run, so the headings can be flat", () => {
    const runs: string[] = [];
    for (const v of SORTED_KOKORO_VOICES) {
      if (runs[runs.length - 1] !== v.accent) runs.push(v.accent);
    }
    expect(runs).toEqual(KOKORO_ACCENTS);
    expect(new Set(runs).size).toBe(runs.length);
  });
});

describe("describeVoice", () => {
  it("names the voice with the right article", () => {
    expect(describeVoice(findVoice("bm_lewis")!)).toBe("Lewis, a British male voice");
    expect(describeVoice(findVoice("af_heart")!)).toBe("Heart, an American female voice");
  });
});

describe("VOICE_STORAGE_KEY", () => {
  // Read Aloud and Converse share one voice. The key keeps Read Aloud's old
  // name so the value already on disk is the value both pages read — a rename
  // here silently resets everyone who has ever chosen a voice.
  it("is the key Read Aloud has always written", () => {
    expect(VOICE_STORAGE_KEY).toBe("readAloudVoice");
  });
});

describe("resolveVoiceId", () => {
  it("accepts a known id", () => {
    expect(resolveVoiceId("bm_fable")).toBe("bm_fable");
  });

  it("falls back for junk, unknown ids, and empty storage", () => {
    expect(resolveVoiceId(null)).toBe(DEFAULT_KOKORO_VOICE_ID);
    expect(resolveVoiceId("")).toBe(DEFAULT_KOKORO_VOICE_ID);
    expect(resolveVoiceId("ff_nonsense")).toBe(DEFAULT_KOKORO_VOICE_ID);
  });

  it("recovers a JSON-quoted value written by an older build", () => {
    expect(resolveVoiceId('"bf_emma"')).toBe("bf_emma");
  });

  it("tolerates surrounding whitespace", () => {
    expect(resolveVoiceId("  am_puck  ")).toBe("am_puck");
  });
});
