function toNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeSpeakerLabel(value) {
  if (value === null || value === undefined || value === "") return null;
  const raw = String(value);
  const display = raw.match(/^speaker\s+(\d+)$/i);
  if (display) return `Speaker ${Number(display[1])}`;
  const numeric = raw.match(/^(?:speaker[_-]*)?(\d+)$/i);
  if (numeric) {
    return `Speaker ${Number(numeric[1]) + 1}`;
  }
  return raw;
}

function normalizeDiarizationSegments(segments = []) {
  return (Array.isArray(segments) ? segments : [])
    .filter(Boolean)
    .map((segment) => {
      const start = Math.max(0, toNumber(segment.start));
      const end = Math.max(start, toNumber(segment.end, start));
      const rawSpeaker =
        segment.speaker ?? segment.speaker_label ?? segment.speakerLabel ?? segment.label;
      const speaker = normalizeSpeakerLabel(rawSpeaker);
      return { start, end, speaker };
    })
    .filter((segment) => segment.speaker && segment.end > segment.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);
}

function overlapSeconds(aStart, aEnd, bStart, bEnd) {
  return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
}

function findBestSpeaker(segment, diarizationSegments, options = {}) {
  const start = Math.max(0, toNumber(segment.start));
  const end = Math.max(start, toNumber(segment.end, start));
  const midpoint = start + (end - start) / 2;
  const minOverlapSeconds = toNumber(options.minOverlapSeconds, 0.05);
  const nearestGapSeconds = toNumber(options.nearestGapSeconds, 1.0);

  const scores = new Map();
  for (const turn of diarizationSegments) {
    const overlap = overlapSeconds(start, end, turn.start, turn.end);
    if (overlap > 0) {
      const score = scores.get(turn.speaker) || {
        speaker: turn.speaker,
        overlap: 0,
        lastEnd: start,
        midpoint: false,
      };
      // Count the union of this speaker's regions, including fragmented turns.
      score.overlap += Math.max(
        0,
        Math.min(end, turn.end) - Math.max(start, turn.start, score.lastEnd)
      );
      score.lastEnd = Math.max(score.lastEnd, turn.end);
      score.midpoint ||= midpoint >= turn.start && midpoint < turn.end;
      scores.set(turn.speaker, score);
    }
  }
  const best = [...scores.values()].sort(
    (a, b) => b.overlap - a.overlap || Number(b.midpoint) - Number(a.midpoint)
  )[0];
  if (best && best.overlap >= minOverlapSeconds) {
    return best.speaker;
  }

  const containingMidpoint = diarizationSegments.find(
    (turn) => midpoint >= turn.start && midpoint < turn.end
  );
  if (containingMidpoint) return containingMidpoint.speaker;

  let nearestPrevious = null;
  for (const turn of diarizationSegments) {
    if (turn.end <= start) {
      const gap = start - turn.end;
      if (gap <= nearestGapSeconds && (!nearestPrevious || gap < nearestPrevious.gap)) {
        nearestPrevious = { speaker: turn.speaker, gap };
      }
    }
  }
  let nearestNext = null;
  for (const turn of diarizationSegments) {
    if (turn.start >= end) {
      const gap = turn.start - end;
      if (gap <= nearestGapSeconds && (!nearestNext || gap < nearestNext.gap)) {
        nearestNext = { speaker: turn.speaker, gap };
      }
    }
  }
  if (nearestPrevious && (!nearestNext || nearestPrevious.gap <= nearestNext.gap)) {
    return nearestPrevious.speaker;
  }
  return nearestNext?.speaker || null;
}

// whisper.cpp's `words` may contain subword tokens. Map them to Unicode word
// boundaries before assigning speakers so Danish compounds and CJK text survive.
function timedWords(segment) {
  if (typeof Intl.Segmenter !== "function") return null;
  if (!Array.isArray(segment.words) || !segment.words.length) return null;
  if (segment.words.some((word) => !word || typeof word !== "object")) return null;
  if (!Number.isFinite(segment.start) || !Number.isFinite(segment.end)) return null;
  const text = String(segment.text || "").trim();
  const pieces = segment.words.map((word) => String(word.word ?? word.text ?? ""));
  const separator = pieces.join("").trim() === text ? "" : " ";
  const assembled = pieces.join(separator);
  if (!text || assembled.trim() !== text) return null;
  const leading = assembled.length - assembled.trimStart().length;
  let cursor = -leading;
  const tokens = segment.words.map((word, index) => {
    const from = cursor;
    cursor += pieces[index].length + separator.length;
    return { from, to: cursor - separator.length, start: word.start, end: word.end };
  });
  const lexical = [...new Intl.Segmenter(undefined, { granularity: "word" }).segment(text)].filter(
    (part) => part.isWordLike
  );
  if (!lexical.length) return null;
  const result = [];
  for (let i = 0; i < lexical.length; i += 1) {
    const part = lexical[i];
    const matching = tokens.filter(
      (token) => token.to > part.index && token.from < part.index + part.segment.length
    );
    if (
      !matching.length ||
      matching.some(
        (token) =>
          !Number.isFinite(token.start) ||
          !Number.isFinite(token.end) ||
          token.start < 0 ||
          token.end < token.start
      )
    )
      return null;
    const start = Math.min(...matching.map((token) => token.start));
    const end = Math.max(...matching.map((token) => token.end));
    if (
      start < segment.start - 0.05 ||
      end > segment.end + 0.05 ||
      (result.length && start < result[result.length - 1].start)
    )
      return null;
    result.push({
      start: Math.max(segment.start, start),
      end: Math.min(segment.end, end),
      text: text.slice(i === 0 ? 0 : part.index, lexical[i + 1]?.index ?? text.length),
    });
  }
  return result;
}

function withSpeaker(segment, speaker) {
  return { ...segment, speaker, speaker_label: speaker, speakerLabel: speaker };
}

function assignSpeakersToSegments(whisperSegments = [], diarizationSegments = [], options = {}) {
  if (!Array.isArray(whisperSegments)) return [];
  const normalizedTurns = normalizeDiarizationSegments(diarizationSegments);
  if (normalizedTurns.length === 0)
    return whisperSegments.map((segment) => withSpeaker(segment, "Unknown speaker"));

  return whisperSegments.flatMap((segment) => {
    const segmentSpeaker = findBestSpeaker(segment, normalizedTurns, options) || "Unknown speaker";
    const words = timedWords(segment);
    if (!words) return [withSpeaker(segment, segmentSpeaker)];
    const turns = [];
    for (const word of words) {
      const speaker = findBestSpeaker(word, normalizedTurns, options) || segmentSpeaker;
      const last = turns[turns.length - 1];
      if (last?.speaker === speaker) {
        last.text += word.text;
        last.end = Math.max(last.end, word.end);
      } else {
        turns.push(withSpeaker({ start: word.start, end: word.end, text: word.text }, speaker));
      }
    }
    return turns;
  });
}

module.exports = {
  assignSpeakersToSegments,
  findBestSpeaker,
  normalizeDiarizationSegments,
  normalizeSpeakerLabel,
  overlapSeconds,
};
