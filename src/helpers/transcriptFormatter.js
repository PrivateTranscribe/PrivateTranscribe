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

function normalizeSegments(verboseJson = {}) {
  const rawSegments = Array.isArray(verboseJson.segments)
    ? verboseJson.segments
    : verboseJson.text
      ? [{ start: 0, end: 0, text: verboseJson.text }]
      : [];

  let currentSpeaker = "Speaker 1";
  let nextSpeakerNumber = 1;
  const speakers = new Set();

  return rawSegments
    .map((segment) => {
      const rawText = String(segment.text || "");
      if (/\[\s*SPEAKER_TURN\s*\]/i.test(rawText)) {
        nextSpeakerNumber += speakers.size === 0 ? 0 : 1;
        currentSpeaker = `Speaker ${nextSpeakerNumber}`;
      }
      const explicitSpeaker = segment.speaker || segment.speaker_label || segment.speakerLabel;
      const speaker = explicitSpeaker ? String(explicitSpeaker) : currentSpeaker;
      const text = cleanText(rawText);
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

function formatTranscript(verboseJson, format = "plain", options = {}) {
  const analysis = buildAnalysis(verboseJson);
  const turns = options.mergeTurns === false ? analysis.segments : mergeTurns(analysis.segments);
  const withSpeakers = format === "speakers" || options.includeSpeakers !== false;

  let text = "";
  if (format === "srt") {
    text = analysis.segments
      .map((segment, index) => {
        const label = withSpeakers ? `${segment.speaker}: ` : "";
        return `${index + 1}\n${formatTimestamp(segment.start, true)} --> ${formatTimestamp(segment.end, true)}\n${label}${segment.text}`;
      })
      .join("\n\n");
  } else if (format === "timestamped") {
    text = turns
      .map((segment) => `[${formatTimestamp(segment.start)}] ${withSpeakers ? `${segment.speaker}: ` : ""}${segment.text}`)
      .join("\n");
  } else {
    text = turns
      .map((segment) => (withSpeakers && analysis.speakerCount > 1 ? `${segment.speaker}: ${segment.text}` : segment.text))
      .join("\n");
  }

  return { ...analysis, text, srt: format === "srt" ? text : formatTranscript(verboseJson, "srt", options).text, format };
}

module.exports = { formatTranscript, cleanText, formatTimestamp };
