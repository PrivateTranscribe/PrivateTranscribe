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
  return String(text || "")
    .replace(/\[\s*SPEAKER_TURN\s*\]/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
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
  cleaned = cleaned.replace(/\s+/g, " ").trim();
  return cleaned;
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
  const segments = normalizeSegments(verboseJson);
  const speakers = Array.from(new Set(segments.map((segment) => segment.speaker)));
  return { speakerCount: speakers.length, speakers, segments };
}

/**
 * Remove consecutive turns that contain the same text (cross-speaker hallucination).
 * Whisper sometimes hallucinates a phrase repeatedly across chunk boundaries, and
 * diarization assigns each repetition to a different speaker. This collapses runs
 * of identical (or substring-contained) consecutive turns.
 */
function deduplicateConsecutiveTurns(turns) {
  if (turns.length <= 1) return turns;
  const result = [turns[0]];
  for (let i = 1; i < turns.length; i++) {
    const prev = result[result.length - 1];
    const curr = turns[i];
    const prevNorm = prev.text.toLowerCase().replace(/[.!?,;:\s]+/g, " ").trim();
    const currNorm = curr.text.toLowerCase().replace(/[.!?,;:\s]+/g, " ").trim();
    // Skip if identical or if one is a substring of the other (catches partial repeats)
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
  const turns = options.mergeTurns === false ? analysis.segments : mergeTurns(analysis.segments);
  const withSpeakers = format === "speakers" || options.includeSpeakers !== false;

  // Clean hallucination artifacts from each turn's text
  for (const turn of turns) {
    turn.text = removeRepetitions(turn.text);
  }
  // Also clean analysis segments used for SRT
  for (const segment of analysis.segments) {
    segment.text = removeRepetitions(segment.text);
  }
  // Remove turns/segments that became empty after cleaning
  const cleanTurns = deduplicateConsecutiveTurns(turns.filter(t => t.text));
  const cleanSegments = deduplicateConsecutiveTurns(analysis.segments.filter(s => s.text));

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
      .map((segment) => `[${formatTimestamp(segment.start)}] ${withSpeakers ? `${segment.speaker}: ` : ""}${segment.text}`)
      .join("\n");
  } else {
    text = cleanTurns
      .map((segment) => (withSpeakers && analysis.speakerCount > 1 ? `${segment.speaker}: ${segment.text}` : segment.text))
      .join("\n");
  }

  return { ...analysis, text, srt: format === "srt" ? text : formatTranscript(verboseJson, "srt", options).text, format };
}

module.exports = { formatTranscript, cleanText, formatTimestamp };
