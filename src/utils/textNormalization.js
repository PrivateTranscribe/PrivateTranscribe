function normalizePunctuationSpacing(text) {
  return String(text || "")
    .replace(/\s+([,.;:!?%])/g, "$1")
    .replace(/([([{])\s+/g, "$1")
    .replace(/\s+([)\]}])/g, "$1");
}

function normalizeTranscriptText(text) {
  return normalizePunctuationSpacing(
    String(text || "")
      .replace(/\n/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  );
}

module.exports = { normalizePunctuationSpacing, normalizeTranscriptText };
