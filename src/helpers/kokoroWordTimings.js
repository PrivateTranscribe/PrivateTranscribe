/** Map Kokoro's spoken phoneme durations back to source words. No audio re-transcription. */
const SPACE_ID = 16;
const FRAMES_PER_SECOND = 40;
const pronunciationCaches = new WeakMap();

// ONNX Round uses ties-to-even, unlike Math.round.
function roundFrame(value) {
  const floor = Math.floor(value);
  return Math.max(1, value === floor + 0.5 ? floor + (floor % 2) : Math.round(value));
}

function sourceWords(text) {
  return Array.from(text.matchAll(/\S+/gu), (match) => ({
    text: match[0],
    start: match.index,
    end: match.index + match[0].length,
  }));
}

/**
 * Context can change a pronunciation ("the apple", "for a"). Align the
 * individually phonemized words to the exact input spoken by the model.
 * Spaces participate in alignment, but never acquire a word highlight.
 */
function alignWordTokens(actual, parts) {
  const expected = [];
  const owners = [];
  parts.forEach((part, word) => {
    if (word) {
      expected.push(SPACE_ID);
      owners.push(-1);
    }
    for (const id of part) {
      expected.push(id);
      owners.push(word);
    }
  });
  if (!actual.length || !expected.length || expected.length > 2048) return null;
  const width = actual.length + 1;
  const costs = new Uint16Array((expected.length + 1) * width);
  for (let j = 0; j <= actual.length; j++) costs[j] = j;
  for (let i = 1; i <= expected.length; i++) {
    costs[i * width] = i;
    for (let j = 1; j <= actual.length; j++) {
      costs[i * width + j] = Math.min(
        costs[(i - 1) * width + j - 1] + (expected[i - 1] === actual[j - 1] ? 0 : 1),
        costs[(i - 1) * width + j] + 1,
        costs[i * width + j - 1] + 1
      );
    }
  }
  // Fail closed for unsupported expansions/truncation, rather than pointing
  // at words the model did not say. Ordinary vowel/stress changes are allowed.
  if (costs[costs.length - 1] / Math.max(actual.length, expected.length) > 0.35) return null;
  const result = Array(actual.length).fill(-1);
  let i = expected.length,
    j = actual.length;
  while (i || j) {
    const here = costs[i * width + j];
    if (
      i &&
      j &&
      here === costs[(i - 1) * width + j - 1] + (expected[i - 1] === actual[j - 1] ? 0 : 1)
    ) {
      result[j - 1] = actual[j - 1] === SPACE_ID ? -1 : owners[i - 1];
      i--;
      j--;
    } else if (i && here === costs[(i - 1) * width + j] + 1) {
      i--;
    } else {
      result[j - 1] = actual[j - 1] === SPACE_ID ? -1 : (owners[Math.max(0, i - 1)] ?? -1);
      j--;
    }
  }
  return result;
}

function buildWordTimings(words, parts, inputIds, durations, audioSeconds) {
  if (!durations || durations.length !== inputIds.length || inputIds.length >= 512) return [];
  const frames = Array.from(durations, (value) => roundFrame(Number(value)));
  if (frames.some((value) => !Number.isFinite(value))) return [];
  // The timestamped export exposes the values before Round/Clip. Its rounded
  // frame total must match the waveform (600 samples per frame at 24 kHz).
  if (Math.abs(frames.reduce((a, b) => a + b, 0) / FRAMES_PER_SECOND - audioSeconds) > 0.026)
    return [];
  const owners = alignWordTokens(inputIds.slice(1, -1), parts);
  if (!owners) return [];
  const spans = words.map(() => null);
  // Same 3-frame onset correction as Kokoro KPipeline.join_timestamps.
  let cursor = Math.max(0, frames[0] - 3) / FRAMES_PER_SECOND;
  owners.forEach((owner, index) => {
    const end = cursor + frames[index + 1] / FRAMES_PER_SECOND;
    if (owner >= 0 && /[\p{L}\p{N}]/u.test(words[owner].text)) {
      if (!spans[owner]) spans[owner] = { ...words[owner], startTime: cursor, endTime: end };
      else spans[owner].endTime = end;
    }
    cursor = end;
  });
  return spans.filter(Boolean);
}

async function synthesizeWithWordTimings(tts, text, options) {
  let inputIds, durations;
  // Per-call wrappers keep concurrent requests from overwriting each other's
  // timings. Kokoro still owns text normalization, phonemization and voices.
  const timed = new tts.constructor(async (inputs) => {
    const output = await tts.model(inputs);
    inputIds = Array.from(inputs.input_ids.data, Number);
    durations = output.durations?.data;
    return output;
  }, tts.tokenizer);
  const audio = await timed.generate(text, options);
  if (!durations || inputIds.length >= 512) return { audio, wordTimings: [] };
  const words = sourceWords(text);
  const phonemizer = new tts.constructor(null, tts.tokenizer);
  phonemizer.generate_from_ids = async (ids) => Array.from(ids.data, Number).slice(1, -1);
  const parts = [];
  let cache = pronunciationCaches.get(tts);
  if (!cache) {
    cache = new Map();
    pronunciationCaches.set(tts, cache);
  }
  try {
    for (const word of words) {
      const key = `${options.voice}:${word.text}`;
      if (!cache.has(key)) {
        if (cache.size >= 512) cache.delete(cache.keys().next().value);
        cache.set(key, await phonemizer.generate(word.text, options));
      }
      parts.push(cache.get(key));
    }
  } catch {
    // Optional positioning metadata must never discard successfully generated audio.
    return { audio, wordTimings: [] };
  }
  return {
    audio,
    wordTimings: buildWordTimings(
      words,
      parts,
      inputIds,
      durations,
      audio.audio.length / audio.sampling_rate
    ),
  };
}

module.exports = { sourceWords, alignWordTokens, buildWordTimings, synthesizeWithWordTimings };
