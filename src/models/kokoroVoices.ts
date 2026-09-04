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
 * Copied from the frozen VOICES table in kokoro-js@1.2.1
 * (node_modules/kokoro-js/dist/kokoro.cjs), in that table's own order: `name`,
 * and `language` mapped to a plain accent word. The decorative `traits` emoji
 * are dropped, and so is the package author's `overallGrade` — a single
 * subjective letter per voice was shown in the picker until 2026-08-30, when
 * Kristian removed it. It graded voices on someone else's ear, in a list where
 * every row already has a play button that answers the question properly.
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
};

/**
 * The voice every feature speaks with until someone picks another one.
 *
 * Chosen by ear rather than by the package's grades: Kristian listened through
 * the list on 2026-08-30 and picked Lewis. Keep in sync with
 * DEFAULT_KOKORO_VOICE in src/helpers/kokoro.js — that one is CommonJS in the
 * main process and cannot import this file.
 */
export const DEFAULT_KOKORO_VOICE_ID = "bm_lewis";

/**
 * localStorage key holding the app's voice id, written raw (no JSON quotes).
 *
 * One key for everything PrivateTranscribe speaks. Read Aloud and Converse had
 * a picker each for a day; Kristian collapsed them on 2026-08-30 — nobody wants
 * their assistant and their narrator to be different people, and two settings
 * for one voice is two places to be wrong.
 *
 * The name is Read Aloud's, kept because that is where the value already lives
 * on every machine that has ever set it. Renaming the key would mean a
 * migration, and a migration is a way to lose a setting.
 */
export const VOICE_STORAGE_KEY = "readAloudVoice";

/** The one Kokoro model in the registry, downloaded from the Read Aloud page. */
export const KOKORO_MODEL_ID = "kokoro-82m-v1.0-fp32";
export const KOKORO_MODEL_LABEL = "Kokoro 82M";
/** Registry total, stated up front so the download is never a surprise. */
export const KOKORO_MODEL_DOWNLOAD_LABEL = "326 MB";

export const KOKORO_VOICES: KokoroVoice[] = [
  { id: "af_heart", name: "Heart", accent: "American", gender: "Female" },
  { id: "af_alloy", name: "Alloy", accent: "American", gender: "Female" },
  { id: "af_aoede", name: "Aoede", accent: "American", gender: "Female" },
  { id: "af_bella", name: "Bella", accent: "American", gender: "Female" },
  { id: "af_jessica", name: "Jessica", accent: "American", gender: "Female" },
  { id: "af_kore", name: "Kore", accent: "American", gender: "Female" },
  { id: "af_nicole", name: "Nicole", accent: "American", gender: "Female" },
  { id: "af_nova", name: "Nova", accent: "American", gender: "Female" },
  { id: "af_river", name: "River", accent: "American", gender: "Female" },
  { id: "af_sarah", name: "Sarah", accent: "American", gender: "Female" },
  { id: "af_sky", name: "Sky", accent: "American", gender: "Female" },
  { id: "am_adam", name: "Adam", accent: "American", gender: "Male" },
  { id: "am_echo", name: "Echo", accent: "American", gender: "Male" },
  { id: "am_eric", name: "Eric", accent: "American", gender: "Male" },
  { id: "am_fenrir", name: "Fenrir", accent: "American", gender: "Male" },
  { id: "am_liam", name: "Liam", accent: "American", gender: "Male" },
  { id: "am_michael", name: "Michael", accent: "American", gender: "Male" },
  { id: "am_onyx", name: "Onyx", accent: "American", gender: "Male" },
  { id: "am_puck", name: "Puck", accent: "American", gender: "Male" },
  { id: "am_santa", name: "Santa", accent: "American", gender: "Male" },
  { id: "bf_emma", name: "Emma", accent: "British", gender: "Female" },
  { id: "bf_isabella", name: "Isabella", accent: "British", gender: "Female" },
  { id: "bm_george", name: "George", accent: "British", gender: "Male" },
  { id: "bm_lewis", name: "Lewis", accent: "British", gender: "Male" },
  { id: "bf_alice", name: "Alice", accent: "British", gender: "Female" },
  { id: "bf_lily", name: "Lily", accent: "British", gender: "Female" },
  { id: "bm_daniel", name: "Daniel", accent: "British", gender: "Male" },
  { id: "bm_fable", name: "Fable", accent: "British", gender: "Male" },
];

/**
 * The picker's list: kokoro-js's original table order, verbatim.
 *
 * Kristian rejected sorting the list by the package's grades on 2026-08-24
 * ("it's very subjective. Just put it in the order that it was in
 * originally"), and the grades themselves are gone as of 2026-08-30. The
 * package author's order is the one every Kokoro user sees elsewhere, and it
 * already runs all the American voices before all the British ones, which is
 * exactly what the picker's accent headings group on.
 */
export const SORTED_KOKORO_VOICES: KokoroVoice[] = [...KOKORO_VOICES];

/** The accents present, in the order the table first mentions them. */
export const KOKORO_ACCENTS: KokoroVoiceAccent[] = SORTED_KOKORO_VOICES.reduce<KokoroVoiceAccent[]>(
  (accents, voice) => (accents.includes(voice.accent) ? accents : [...accents, voice.accent]),
  []
);

export function findVoice(id: string | null | undefined): KokoroVoice | undefined {
  return KOKORO_VOICES.find((voice) => voice.id === id);
}

/**
 * "Lewis, a British male voice" — the one phrase every screen uses to name a
 * voice, so the article and the casing cannot drift between two pages.
 */
export function describeVoice(voice: KokoroVoice): string {
  const article = voice.accent === "American" ? "an" : "a";
  return `${voice.name}, ${article} ${voice.accent} ${voice.gender.toLowerCase()} voice`;
}

/**
 * Turn whatever is in localStorage into a voice id the engine will accept.
 *
 * The value is written raw, but an older build (or a hand-edited profile)
 * could have left a JSON-quoted copy behind, and an id from a future kokoro-js
 * would throw inside `generate()` rather than degrade. Both fall back to the
 * default instead of taking playback down.
 */
export function resolveVoiceId(raw: string | null | undefined): string {
  if (typeof raw !== "string") return DEFAULT_KOKORO_VOICE_ID;

  const trimmed = raw.trim().replace(/^"(.*)"$/, "$1");
  return findVoice(trimmed) ? trimmed : DEFAULT_KOKORO_VOICE_ID;
}

/**
 * Read a stored voice id straight out of localStorage.
 *
 * The pickers live in the control panel; the players live in the overlay,
 * which may have been running since before the window that changed the value
 * existed. Rather than plumbing a cross-window event for something needed at
 * exactly one instant, the players re-read the key immediately before they
 * speak. Storage being unavailable is not worth surfacing here — the default
 * voice still speaks.
 */
export function readStoredVoiceId(storageKey: string): string {
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(storageKey);
  } catch {
    // Storage unavailable; resolveVoiceId falls back to the default.
  }
  return resolveVoiceId(stored);
}
