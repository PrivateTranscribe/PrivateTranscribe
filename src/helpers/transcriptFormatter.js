const { normalizeTranscriptText } = require("../utils/textNormalization");

function pad2(value) {
  return String(Math.floor(Math.max(0, value))).padStart(2, "0");
}

function formatTimestamp(seconds = 0, srt = false) {
  const safe = Math.max(0, Number(seconds) || 0);
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const secs = Math.floor(safe % 60);
  const millis = Math.floor((safe - Math.floor(safe)) * 1000);
  return srt
    ? `${pad2(hours)}:${pad2(minutes)}:${pad2(secs)},${String(millis).padStart(3, "0")}`
    : `${pad2(hours)}:${pad2(minutes)}:${pad2(secs)}`;
}

function cleanText(text) {
  return normalizeTranscriptText(String(text || "").replace(/\[\s*SPEAKER_TURN\s*\]/gi, " "));
}

/**
 * Remove whisper.cpp hallucination artifacts — repeated phrases and single-word
 * stutters that appear when the model loops on non-English or long-silence audio.
 */
function removeRepetitions(text) {
  if (!text) return text;
  let cleaned = text;

  // 1) Collapse long repeated phrases (3–30 word n-grams repeated 3+ times)
  for (let n = 30; n >= 3; n--) {
    const phrasePattern = new RegExp(`((?:\\S+\\s+){${n - 1}}\\S+)(?:\\s+\\1){2,}`, "gi");
    cleaned = cleaned.replace(phrasePattern, "$1");
  }

  // 2) Collapse single-word stutters (3+ consecutive identical words/tokens including punctuation)
  // Handles "Ja. Ja. Ja. Ja." and "Hvad? Hvad? Hvad?" patterns
  cleaned = cleaned.replace(/(\S+[.!?]?)(?:\s+\1){2,}/gi, "$1");

  // 3) Collapse repeated single characters (e.g. "åååååå..." → "å")
  cleaned = cleaned.replace(/(.)\1{9,}/g, "$1");

  // 4) Re-normalize whitespace
  cleaned = normalizeTranscriptText(cleaned);
  return cleaned;
}

/**
 * Minimum length for a cue whose own timestamps say it takes no time at all.
 *
 * SRT resolves to a millisecond, but the stamps are rendered by truncating a
 * float, so extending a cue by exactly one millisecond can render as no
 * extension at all (1260.559 truncates to ,558). Ten milliseconds survives that
 * rounding and is still shorter than any cue a listener could perceive.
 */
const MIN_CUE_SECONDS = 0.01;

/**
 * Make a segment timeline strictly forward-moving.
 *
 * Long audio is decoded in 60-second chunks and each chunk's segments are
 * offset by that chunk's start. whisper.cpp's last segment in a chunk can end
 * past the chunk's nominal length, so the overrun lands on top of the next
 * chunk's first segment: on the measured 32:04 file that produced 13
 * overlapping cues, 5 of zero or negative length, and 2 that ran backwards
 * (1260.559s -> 1260.000s, 1560.039s -> 1560.000s — both exactly on chunk
 * boundaries). Strict SRT validators and some editors reject that file.
 *
 * The repair keeps transcript order — sorting by start would reorder the words
 * themselves — and only ever moves a boundary forward: a cue that starts before
 * the previous one ended is pushed to that end, and a cue with no length gets
 * the smallest length SRT can carry. Nothing is moved earlier, no text changes,
 * and the shift is bounded by the overrun itself (under a second at a 60-second
 * boundary).
 */
function makeTimelineForwardMoving(segments) {
  let previousEnd = null;
  return segments.map((segment) => {
    let start = segment.start;
    let end = segment.end;
    if (previousEnd !== null && start < previousEnd) start = previousEnd;
    if (!(end > start)) end = start + MIN_CUE_SECONDS;
    previousEnd = end;
    return start === segment.start && end === segment.end ? segment : { ...segment, start, end };
  });
}

function normalizeSegments(verboseJson = {}) {
  const rawSegments = Array.isArray(verboseJson.segments)
    ? verboseJson.segments
    : verboseJson.text
      ? [{ start: 0, end: 0, text: verboseJson.text }]
      : [];

  let currentSpeakerIndex = 1;
  const speakers = new Set();

  return rawSegments
    .map((segment) => {
      const rawText = String(segment.text || "");
      const startsWithTurn = /^\s*\[\s*SPEAKER_TURN\s*\]/i.test(rawText);
      const hasTurnAfterSegment = /\[\s*SPEAKER_TURN\s*\]\s*$/i.test(rawText) && !startsWithTurn;

      if (startsWithTurn && speakers.size > 0) {
        currentSpeakerIndex = currentSpeakerIndex === 1 ? 2 : 1;
      }

      const explicitSpeaker = segment.speaker || segment.speaker_label || segment.speakerLabel;
      const speaker = explicitSpeaker ? String(explicitSpeaker) : `Speaker ${currentSpeakerIndex}`;
      const text = cleanText(rawText);

      if (hasTurnAfterSegment) {
        currentSpeakerIndex = currentSpeakerIndex === 1 ? 2 : 1;
      }

      if (!text) return null;
      speakers.add(speaker);
      return {
        start: Number(segment.start) || 0,
        end: Number(segment.end) || Number(segment.start) || 0,
        text,
        speaker,
      };
    })
    .filter(Boolean);
}

function mergeTurns(segments) {
  const turns = [];
  for (const segment of segments) {
    const last = turns[turns.length - 1];
    if (last && last.speaker === segment.speaker) {
      last.end = segment.end;
      last.text = `${last.text} ${segment.text}`.trim();
    } else {
      turns.push({ ...segment });
    }
  }
  return turns;
}

function buildAnalysis(verboseJson) {
  // Chunked decodes hand back segments whose timestamps overlap at the chunk
  // seams, so the timeline is repaired once here — every format below reads
  // these segments, and a cue that runs backwards is invalid in all of them.
  const segments = makeTimelineForwardMoving(normalizeSegments(verboseJson));
  const speakers = Array.from(
    new Set(
      segments.map((segment) => segment.speaker).filter((speaker) => speaker !== "Unknown speaker")
    )
  );
  return { speakerCount: speakers.length, speakers, segments };
}

// Text repetition alone is not evidence of a duplicate. Speakers can echo each
// other or repeat themselves; only consider overlapping copies from one speaker.
function deduplicateConsecutiveTurns(turns) {
  if (turns.length <= 1) return turns;
  const result = [turns[0]];
  for (let i = 1; i < turns.length; i++) {
    const prev = result[result.length - 1];
    const curr = turns[i];
    const prevNorm = prev.text
      .toLowerCase()
      .replace(/[.!?,;:\s]+/g, " ")
      .trim();
    const currNorm = curr.text
      .toLowerCase()
      .replace(/[.!?,;:\s]+/g, " ")
      .trim();
    // Repeated replies by different speakers are real conversation, not evidence
    // of hallucination. Only deduplicate the same speaker at overlapping times.
    if (curr.speaker !== prev.speaker || curr.start >= prev.end) {
      result.push(curr);
      continue;
    }
    if (currNorm === prevNorm) continue;
    if (prevNorm.length > 10 && currNorm.length > 10) {
      if (prevNorm.includes(currNorm) || currNorm.includes(prevNorm)) continue;
    }
    result.push(curr);
  }
  return result;
}

function formatTranscript(verboseJson, format = "plain", options = {}) {
  const analysis = buildAnalysis(verboseJson);
  const hasExplicitSpeakers =
    Array.isArray(verboseJson.segments) &&
    verboseJson.segments.some(
      (segment) =>
        segment.speaker != null || segment.speaker_label != null || segment.speakerLabel != null
    );
  const withSpeakers = format === "speakers" || options.includeSpeakers !== false;
  const showSpeakerLabels =
    withSpeakers &&
    (analysis.speakerCount > 1 ||
      analysis.segments.some((segment) => segment.speaker === "Unknown speaker"));
  // Turns are merged by speaker. With speaker labels off, every segment carries
  // the same placeholder speaker, so merging folds the entire file into one
  // turn — and a timestamped transcript of one turn is a single line stamped
  // [00:00:00], whatever its length. Timestamped output without speakers
  // therefore keeps the segments it is supposed to be stamping.
  const turns =
    options.mergeTurns === false || (format === "timestamped" && !withSpeakers)
      ? analysis.segments
      : mergeTurns(analysis.segments);

  // Preserve explicitly attributed speech, including repeated answers.
  for (const turn of turns) {
    turn.text = hasExplicitSpeakers ? cleanText(turn.text) : removeRepetitions(turn.text);
  }
  // Also clean analysis segments used for SRT
  for (const segment of analysis.segments) {
    segment.text = hasExplicitSpeakers ? cleanText(segment.text) : removeRepetitions(segment.text);
  }
  // Remove turns/segments that became empty after cleaning
  const cleanTurns = deduplicateConsecutiveTurns(turns.filter((t) => t.text));
  const cleanSegments = deduplicateConsecutiveTurns(analysis.segments.filter((s) => s.text));

  let text = "";
  if (format === "srt") {
    text = cleanSegments
      .map((segment, index) => {
        const label = withSpeakers ? `${segment.speaker}: ` : "";
        return `${index + 1}\n${formatTimestamp(segment.start, true)} --> ${formatTimestamp(segment.end, true)}\n${label}${segment.text}`;
      })
      .join("\n\n");
  } else if (format === "timestamped") {
    text = cleanTurns
      .map(
        (segment) =>
          `[${formatTimestamp(segment.start)}] ${withSpeakers ? `${segment.speaker}: ` : ""}${segment.text}`
      )
      .join("\n");
  } else {
    text = cleanTurns
      .map((segment) => (showSpeakerLabels ? `${segment.speaker}: ${segment.text}` : segment.text))
      .join("\n");
  }

  return {
    ...analysis,
    text,
    srt: format === "srt" ? text : formatTranscript(verboseJson, "srt", options).text,
    format,
  };
}

module.exports = { formatTranscript, cleanText, formatTimestamp };
