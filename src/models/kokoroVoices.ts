/**
 * The Kokoro voices PrivateTranscribe can actually speak with.
 *
 * The model ships 54 voice files, but the phonemizer bundled with kokoro-js
 * (espeak-ng compiled to WASM) only has English. Every non-English language id
 * is rejected before synthesis starts, so the other 26 voices are not "not
 * offered yet" — they cannot produce audio in this build at all. Listing them
 * would be a menu of dead ends, so this table is the 28 English voices and
 * nothing else.
 *
 * Copied verbatim from the frozen VOICES table in kokoro-js@1.2.1
 * (node_modules/kokoro-js/dist/kokoro.cjs): `name`, `language` mapped to a
 * plain accent word, `gender`, and `overallGrade`. The decorative `traits`
 * emoji are dropped. `overallGrade` is used rather than `targetQuality`
 * because the former is what the package author heard, and the latter is what
 * they were aiming for.
 *
 * Guard rail: tests/unit/models/kokoroVoices.test.ts cross-checks every id in
 * here against the .bin files in the installed package, so a kokoro-js upgrade
 * that renames or drops a voice fails a unit test instead of failing at
 * synthesis time in front of a user.
 */

export type KokoroVoiceAccent = "American" | "British";
export type KokoroVoiceGender = "Female" | "Male";

export type KokoroVoice = {
  /** Voice id passed to `readAloudSynth({ voice })`. */
  id: string;
  /** Display name, e.g. "Heart". */
  name: string;
  accent: KokoroVoiceAccent;
  gender: KokoroVoiceGender;
  /** The package author's own listening grade, verbatim: "A", "B-", "F+". */
  grade: string;
};

/** The voice used when nothing has been chosen; matches DEFAULT_KOKORO_VOICE. */
export const DEFAULT_KOKORO_VOICE_ID = "af_heart";

/** localStorage key holding the chosen voice id, written raw (no JSON quotes). */
export const READ_ALOUD_VOICE_STORAGE_KEY = "readAloudVoice";

export const KOKORO_VOICES: KokoroVoice[] = [
  { id: "af_heart", name: "Heart", accent: "American", gender: "Female", grade: "A" },
  { id: "af_alloy", name: "Alloy", accent: "American", gender: "Female", grade: "C" },
  { id: "af_aoede", name: "Aoede", accent: "American", gender: "Female", grade: "C+" },
  { id: "af_bella", name: "Bella", accent: "American", gender: "Female", grade: "A-" },
  { id: "af_jessica", name: "Jessica", accent: "American", gender: "Female", grade: "D" },
  { id: "af_kore", name: "Kore", accent: "American", gender: "Female", grade: "C+" },
  { id: "af_nicole", name: "Nicole", accent: "American", gender: "Female", grade: "B-" },
  { id: "af_nova", name: "Nova", accent: "American", gender: "Female", grade: "C" },
  { id: "af_river", name: "River", accent: "American", gender: "Female", grade: "D" },
  { id: "af_sarah", name: "Sarah", accent: "American", gender: "Female", grade: "C+" },
  { id: "af_sky", name: "Sky", accent: "American", gender: "Female", grade: "C-" },
  { id: "am_adam", name: "Adam", accent: "American", gender: "Male", grade: "F+" },
  { id: "am_echo", name: "Echo", accent: "American", gender: "Male", grade: "D" },
  { id: "am_eric", name: "Eric", accent: "American", gender: "Male", grade: "D" },
  { id: "am_fenrir", name: "Fenrir", accent: "American", gender: "Male", grade: "C+" },
  { id: "am_liam", name: "Liam", accent: "American", gender: "Male", grade: "D" },
  { id: "am_michael", name: "Michael", accent: "American", gender: "Male", grade: "C+" },
  { id: "am_onyx", name: "Onyx", accent: "American", gender: "Male", grade: "D" },
  { id: "am_puck", name: "Puck", accent: "American", gender: "Male", grade: "C+" },
  { id: "am_santa", name: "Santa", accent: "American", gender: "Male", grade: "D-" },
  { id: "bf_emma", name: "Emma", accent: "British", gender: "Female", grade: "B-" },
  { id: "bf_isabella", name: "Isabella", accent: "British", gender: "Female", grade: "C" },
  { id: "bm_george", name: "George", accent: "British", gender: "Male", grade: "C" },
  { id: "bm_lewis", name: "Lewis", accent: "British", gender: "Male", grade: "D+" },
  { id: "bf_alice", name: "Alice", accent: "British", gender: "Female", grade: "D" },
  { id: "bf_lily", name: "Lily", accent: "British", gender: "Female", grade: "D" },
  { id: "bm_daniel", name: "Daniel", accent: "British", gender: "Male", grade: "D" },
  { id: "bm_fable", name: "Fable", accent: "British", gender: "Male", grade: "C" },
];

/** Best letter first. Kokoro grades skip E, so the scale is A B C D F. */
const GRADE_LETTERS = ["A", "B", "C", "D", "F"];

/**
 * Rank a grade so a plain sort puts the best-sounding voice first.
 *
 * Letter dominates, then the modifier within that letter: "+" beats a bare
 * letter, which beats "-". So A, A-, B-, C+, C, C-, D+, D, D-, F+. An
 * unrecognised grade sorts last rather than throwing — a kokoro-js upgrade
 * introducing a new grade should push that voice down the list, not break the
 * page. (The unit test still catches the id drift that matters.)
 */
export function gradeRank(grade: string): number {
  const letterIndex = GRADE_LETTERS.indexOf(grade.charAt(0).toUpperCase());
  if (letterIndex === -1) return Number.MAX_SAFE_INTEGER;

  const modifier = grade.slice(1).trim();
  const modifierRank = modifier === "+" ? 0 : modifier === "" ? 1 : 2;
  return letterIndex * 3 + modifierRank;
}

/**
 * The order the picker shows voices in: best grade first, American before
 * British inside a grade, then name A-Z.
 *
 * Grade leads because the user is choosing by ear and has no other way to
 * guess which of 28 names sounds good — the grade is the package author's own
 * listening judgement, so it is the closest thing to a preview that exists
 * before you press play. Accent groups within a grade because a run of
 * American names followed by a run of British ones is scannable, while
 * alternating them is not; name A-Z last so the order is stable and a voice
 * stays where the user last saw it.
 *
 * Does not mutate the input.
 */
export function sortVoices(voices: KokoroVoice[]): KokoroVoice[] {
  return [...voices].sort((a, b) => {
    const byGrade = gradeRank(a.grade) - gradeRank(b.grade);
    if (byGrade !== 0) return byGrade;

    if (a.accent !== b.accent) return a.accent === "American" ? -1 : 1;

    return a.name.localeCompare(b.name, "en");
  });
}

/** The picker's list, computed once — the table never changes at runtime. */
export const SORTED_KOKORO_VOICES: KokoroVoice[] = sortVoices(KOKORO_VOICES);

export function findVoice(id: string | null | undefined): KokoroVoice | undefined {
  return KOKORO_VOICES.find((voice) => voice.id === id);
}

/**
 * Turn whatever is in localStorage into a voice id the engine will accept.
 *
 * The value is written raw, but an older build (or a hand-edited profile)
 * could have left a JSON-quoted copy behind, and an id from a future kokoro-js
 * would throw inside `generate()` rather than degrade. Both fall back to the
 * default instead of taking Read Aloud down.
 */
export function resolveVoiceId(raw: string | null | undefined): string {
  if (typeof raw !== "string") return DEFAULT_KOKORO_VOICE_ID;

  const trimmed = raw.trim().replace(/^"(.*)"$/, "$1");
  return findVoice(trimmed) ? trimmed : DEFAULT_KOKORO_VOICE_ID;
}
