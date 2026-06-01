function toNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeSpeakerLabel(value) {
  if (value === null || value === undefined || value === "") return null;
  const raw = String(value);
  const numeric = raw.match(/^(?:speaker[_\s-]*)?(\d+)$/i);
  if (numeric) {
    return `Speaker ${Number(numeric[1]) + 1}`;
  }
  const canonical = raw.match(/^speaker[_\s-]*(\d+)$/i);
  if (canonical) {
    return `Speaker ${Number(canonical[1]) + 1}`;
  }
  return raw.replace(/^SPEAKER_(\d+)$/i, (_, n) => `Speaker ${Number(n) + 1}`);
}

function normalizeDiarizationSegments(segments = []) {
  return (Array.isArray(segments) ? segments : [])
    .map((segment, index) => {
      const start = Math.max(0, toNumber(segment.start));
      const end = Math.max(start, toNumber(segment.end, start));
      const rawSpeaker =
        segment.speaker ?? segment.speaker_label ?? segment.speakerLabel ?? segment.label;
      const speaker = normalizeSpeakerLabel(rawSpeaker) || `Speaker ${index + 1}`;
      return { start, end, speaker };
    })
    .filter((segment) => segment.end > segment.start)
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

  let best = null;
  for (const turn of diarizationSegments) {
    const overlap = overlapSeconds(start, end, turn.start, turn.end);
    if (overlap > 0 && (!best || overlap > best.overlap)) {
      best = { speaker: turn.speaker, overlap };
    }
  }

  if (best && best.overlap >= minOverlapSeconds) {
    return best.speaker;
  }

  const containingMidpoint = diarizationSegments.find(
    (turn) => midpoint >= turn.start && midpoint <= turn.end
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
  if (nearestPrevious) return nearestPrevious.speaker;

  let nearestNext = null;
  for (const turn of diarizationSegments) {
    if (turn.start >= end) {
      const gap = turn.start - end;
      if (gap <= nearestGapSeconds && (!nearestNext || gap < nearestNext.gap)) {
        nearestNext = { speaker: turn.speaker, gap };
      }
    }
  }
  return nearestNext?.speaker || null;
}

function assignSpeakersToSegments(whisperSegments = [], diarizationSegments = [], options = {}) {
  if (!Array.isArray(whisperSegments)) return [];
  const normalizedTurns = normalizeDiarizationSegments(diarizationSegments);
  if (normalizedTurns.length === 0) return whisperSegments.map((segment) => ({ ...segment }));

  return whisperSegments.map((segment) => {
    const speaker = findBestSpeaker(segment, normalizedTurns, options);
    if (!speaker) return { ...segment };
    return {
      ...segment,
      speaker,
      speaker_label: speaker,
      speakerLabel: speaker,
    };
  });
}

module.exports = {
  assignSpeakersToSegments,
  findBestSpeaker,
  normalizeDiarizationSegments,
  normalizeSpeakerLabel,
  overlapSeconds,
};
