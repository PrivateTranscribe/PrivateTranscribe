import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";
import {
  DEFAULT_KOKORO_VOICE_ID,
  KOKORO_VOICES,
  SORTED_KOKORO_VOICES,
  findVoice,
  gradeRank,
  resolveVoiceId,
  sortVoices,
  type KokoroVoice,
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

const voice = (overrides: Partial<KokoroVoice>): KokoroVoice => ({
  id: "x",
  name: "X",
  accent: "American",
  gender: "Female",
  grade: "C",
  ...overrides,
});

/** Names in the order sortVoices produced them, for readable assertions. */
const orderOf = (voices: KokoroVoice[]) => sortVoices(voices).map((v) => v.name);

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

describe("gradeRank", () => {
  it("orders letters best-first", () => {
    expect(gradeRank("A")).toBeLessThan(gradeRank("B"));
    expect(gradeRank("B")).toBeLessThan(gradeRank("C"));
    expect(gradeRank("D")).toBeLessThan(gradeRank("F"));
  });

  it("orders + above bare above - within a letter", () => {
    expect(gradeRank("B+")).toBeLessThan(gradeRank("B"));
    expect(gradeRank("B")).toBeLessThan(gradeRank("B-"));
    expect(gradeRank("A")).toBeLessThan(gradeRank("A-"));
  });

  it("keeps a whole letter ahead of the next letter's best modifier", () => {
    expect(gradeRank("A-")).toBeLessThan(gradeRank("B+"));
  });

  it("sinks an unrecognised grade instead of throwing", () => {
    expect(gradeRank("Z")).toBeGreaterThan(gradeRank("F"));
    expect(gradeRank("")).toBeGreaterThan(gradeRank("F"));
  });
});

describe("sortVoices", () => {
  it("puts a better grade first", () => {
    expect(
      orderOf([
        voice({ name: "Bee", grade: "B" }),
        voice({ name: "Ay", grade: "A" }),
        voice({ name: "AyMinus", grade: "A-" }),
        voice({ name: "BeePlus", grade: "B+" }),
        voice({ name: "BeeMinus", grade: "B-" }),
      ])
    ).toEqual(["Ay", "AyMinus", "BeePlus", "Bee", "BeeMinus"]);
  });

  it("puts American before British inside one grade", () => {
    expect(
      orderOf([
        voice({ name: "Brit", accent: "British", grade: "C" }),
        voice({ name: "Yank", accent: "American", grade: "C" }),
      ])
    ).toEqual(["Yank", "Brit"]);
  });

  it("falls back to name A-Z", () => {
    expect(
      orderOf([
        voice({ name: "Zoe", grade: "C" }),
        voice({ name: "Amy", grade: "C" }),
        voice({ name: "Mia", grade: "C" }),
      ])
    ).toEqual(["Amy", "Mia", "Zoe"]);
  });

  it("does not mutate its input", () => {
    const input = [voice({ name: "Zoe", grade: "D" }), voice({ name: "Amy", grade: "A" })];
    sortVoices(input);
    expect(input.map((v) => v.name)).toEqual(["Zoe", "Amy"]);
  });

  it("leads the real table with the grade-A voice", () => {
    const first = SORTED_KOKORO_VOICES[0];
    expect(first.grade).toBe("A");
    expect(first.id).toBe("af_heart");
  });

  it("returns every voice exactly once", () => {
    expect(SORTED_KOKORO_VOICES).toHaveLength(KOKORO_VOICES.length);
    expect(new Set(SORTED_KOKORO_VOICES.map((v) => v.id)).size).toBe(KOKORO_VOICES.length);
  });

  it("never lets a worse grade appear above a better one", () => {
    const ranks = SORTED_KOKORO_VOICES.map((v) => gradeRank(v.grade));
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
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
