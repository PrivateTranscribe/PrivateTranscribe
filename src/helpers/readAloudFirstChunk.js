/**
 * First-chunk splitting for Read Aloud (renderer, pure).
 *
 * Kokoro's synthesis time scales with the text it is given: measured warm on
 * this machine (fp32/CPU, af_heart), a 26-char string takes ~213ms, a 40-char
 * string ~274ms and a 79-char sentence ~475ms — roughly 60ms fixed plus
 * ~5ms per character. That linearity is the whole reason this file exists: a
 * press that waits for the entire first sentence pays for audio the listener
 * will not hear for another four seconds.
 *
 * So the first sentence of a fresh press is spoken in two pieces. The head is
 * synthesized and played immediately; the tail is synthesized while the head
 * plays and scheduled to start exactly where the head ends. Everything else in
 * the player — the sentence counter, the sentence line, seek — keeps treating
 * sentence 0 as one sentence. Chunking is invisible except in time.
 *
 * The constants are budgets, not taste:
 *
 *  - MIN is the gate's floor. A head shorter than 25 characters buys little and
 *    risks an unnatural clip.
 *  - TARGET_MAX is derived from the latency budget: press→first-audio must land
 *    under 350ms, ~90ms of that is the press path itself, so the head's
 *    synthesis has ~250ms — about 35 characters at the measured rate.
 *  - HARD_MAX is a relief valve for text whose only boundary sits past the
 *    target window. A 45-char head is still far better than a 120-char one.
 *  - MIN_SENTENCE keeps short sentences whole: they already synthesize fast
 *    enough that a seam would cost more than it saves.
 */

export const FIRST_CHUNK_MIN_CHARS = 25;
export const FIRST_CHUNK_TARGET_MAX_CHARS = 35;
export const FIRST_CHUNK_HARD_MAX_CHARS = 45;
export const FIRST_CHUNK_MIN_SENTENCE_CHARS = 50;
/** A tail this short is not worth a seam of its own. */
const MIN_TAIL_CHARS = 5;

/**
 * Punctuation that ends a clause without ending a sentence. Sentence-ending
 * punctuation is not listed: the sentence splitter already ran, so a `.` inside
 * a sentence is an abbreviation, not a boundary.
 */
const CLAUSE_PUNCTUATION = new Set([",", ";", ":", "—", "–"]);

/**
 * Every place this sentence could legally be cut: after a run of whitespace,
 * never inside a word.
 */
function collectCandidates(sentence) {
  const candidates = [];

  for (let i = 1; i < sentence.length - 1; i++) {
    if (sentence[i] !== " " && sentence[i] !== "\t" && sentence[i] !== "\n") continue;

    const head = sentence.slice(0, i);
    const tail = sentence.slice(i + 1).replace(/^\s+/, "");
    if (!head || !tail) continue;

    const lastChar = head[head.length - 1];

    // "1 000", "3 500 kr" — a space between digits is a thousands separator in
    // several of the languages this app sees, never a place to stop speaking.
    if (/\d$/.test(head) && /^\d/.test(tail)) continue;
    // A `.` this far from the end is an abbreviation ("Dr. Hansen", "kl. 14"),
    // and stopping right after it reads as a sentence end that is not there.
    if (lastChar === ".") continue;

    candidates.push({
      head,
      tail,
      length: head.length,
      punctuated: CLAUSE_PUNCTUATION.has(lastChar),
    });
  }

  return candidates;
}

/** Earliest punctuated candidate in the range, else the earliest candidate. */
function pickInRange(candidates, minChars, maxChars) {
  const inRange = candidates.filter(
    (candidate) =>
      candidate.length >= minChars &&
      candidate.length <= maxChars &&
      candidate.tail.length >= MIN_TAIL_CHARS
  );
  if (!inRange.length) return null;
  return inRange.find((candidate) => candidate.punctuated) || inRange[0];
}

/**
 * Split `sentence` into a fast head and the remainder, or return null when the
 * sentence should be spoken whole.
 *
 * @param {string} sentence
 * @returns {{ head: string, tail: string, punctuated: boolean } | null}
 */
export function splitFirstChunk(sentence) {
  const text = String(sentence ?? "");
  if (text.trim().length < FIRST_CHUNK_MIN_SENTENCE_CHARS) return null;

  const candidates = collectCandidates(text);
  if (!candidates.length) return null;

  const chosen =
    pickInRange(candidates, FIRST_CHUNK_MIN_CHARS, FIRST_CHUNK_TARGET_MAX_CHARS) ||
    pickInRange(candidates, FIRST_CHUNK_TARGET_MAX_CHARS + 1, FIRST_CHUNK_HARD_MAX_CHARS);

  if (!chosen) return null;
  return { head: chosen.head, tail: chosen.tail, punctuated: chosen.punctuated };
}

/**
 * How the seam between the two chunks is kept from sounding like a hole.
 *
 * Kokoro pads every utterance with silence: measured on the fixture split,
 * 448ms trails the head and 324ms leads the tail — 772ms of dead air at the
 * join, which Kristian heard immediately ("it pauses in the middle of the
 * text"). The padding is per-utterance framing, not prosody, so it is trimmed
 * at the seam: the head keeps a short trail and the tail a short lead, adding
 * up to roughly the gap the model itself puts between words. The head's lead
 * is trimmed too — the press is answered by sound, not by 300ms of silence
 * being "played". Tail-end padding is left alone; it is the pause before the
 * next sentence.
 */
export const SILENCE_THRESHOLD = 0.005;
export const HEAD_KEEP_LEAD_MS = 40;
export const HEAD_KEEP_TRAIL_MS = 60;
export const TAIL_KEEP_LEAD_MS = 60;

/**
 * Trim leading/trailing silence from PCM, keeping `keepLeadMs`/`keepTrailMs`
 * of it. Pass null to leave that end untouched. Returns a subarray view (no
 * copy), or the input untouched when trimming would leave nothing.
 *
 * @param {Float32Array} pcm
 * @param {number} sampleRate
 * @param {{ keepLeadMs?: number | null, keepTrailMs?: number | null }} opts
 * @returns {Float32Array}
 */
export function trimSilence(pcm, sampleRate, { keepLeadMs = null, keepTrailMs = null } = {}) {
  if (!pcm || !pcm.length || !sampleRate) return pcm;

  let start = 0;
  if (keepLeadMs !== null) {
    let lead = 0;
    while (lead < pcm.length && Math.abs(pcm[lead]) < SILENCE_THRESHOLD) lead++;
    start = Math.max(0, lead - Math.round((keepLeadMs / 1000) * sampleRate));
  }

  let end = pcm.length;
  if (keepTrailMs !== null) {
    let trail = 0;
    while (trail < pcm.length && Math.abs(pcm[pcm.length - 1 - trail]) < SILENCE_THRESHOLD) trail++;
    end = Math.min(pcm.length, pcm.length - trail + Math.round((keepTrailMs / 1000) * sampleRate));
  }

  // An all-silence buffer (or a degenerate window) is returned whole rather
  // than trimmed into nothing: silence that plays is better than a crash.
  if (end - start <= 0) return pcm;
  return pcm.subarray(start, end);
}

export default splitFirstChunk;
