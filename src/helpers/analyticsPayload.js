const ALLOWED_ANALYTICS_EVENTS = new Set([
  "app_launched",
  "onboarding_started",
  "onboarding_step_viewed",
  "onboarding_completed",
  "transcription_started",
  "transcription_completed",
  "first_transcription_completed",
  "settings_opened",
  "starter_words_used",
  "starter_limit_reached",
  "starter_limit_hit",
  "starter_file_words_used",
]);

const ALLOWED_ANALYTICS_PROPERTY_KEYS = new Set([
  "launch_context",
  "step",
  "step_count",
  "source",
  "output_action",
  "word_count_bucket",
  "duration_bucket",
  "language",
  "model",
  "compute_mode",
  "realtime_factor_x100",
  "words_added",
  "words_used",
  "daily_limit",
  "limit_reached",
]);

const STRING_ENUMS = {
  launch_context: new Set(["consent_granted"]),
  output_action: new Set(["paste", "copy", "action", "none"]),
  word_count_bucket: new Set(["1-10", "11-50", "51-200", "201-1000", "1001+"]),
  duration_bucket: new Set(["unknown", "0-5s", "6-15s", "16-60s", "61-300s", "301s+"]),
  compute_mode: new Set(["cpu", "cuda", "cloud", "mixed", "unknown"]),
};

const ALLOWED_ANALYTICS_LANGUAGES = new Set([
  "unset",
  "custom",
  "auto",
  "af",
  "ar",
  "hy",
  "az",
  "be",
  "bs",
  "bg",
  "ca",
  "zh",
  "hr",
  "cs",
  "da",
  "nl",
  "en",
  "et",
  "fi",
  "fr",
  "gl",
  "de",
  "el",
  "he",
  "hi",
  "hu",
  "is",
  "id",
  "it",
  "ja",
  "kn",
  "kk",
  "ko",
  "lv",
  "lt",
  "mk",
  "ms",
  "mr",
  "mi",
  "ne",
  "no",
  "fa",
  "pl",
  "pt",
  "ro",
  "ru",
  "sr",
  "sk",
  "sl",
  "es",
  "sw",
  "sv",
  "tl",
  "ta",
  "th",
  "tr",
  "uk",
  "ur",
  "vi",
  "cy",
]);

const ALLOWED_ANALYTICS_MODELS = new Set([
  "unknown",
  "custom",
  "tiny",
  "base",
  "small",
  "small-en-tdrz",
  "medium",
  "large",
  "turbo",
  "parakeet-tdt-0.6b-v3",
  "gpt-transcribe",
  "gpt-4o-mini-transcribe",
  "gpt-4o-transcribe",
  "gpt-4o-transcribe-diarize",
  "whisper-1",
  "whisper-large-v3-turbo",
  "whisper-large-v3",
  "mixed",
]);

const ALLOWED_ANALYTICS_SOURCES = new Set([
  "unknown",
  "local",
  "local-parakeet",
  "openai",
  "openai-reasoned",
  "openai-fallback",
  "local-fallback",
  "local-file-v2",
  "long-session",
  "long-session-reasoned",
  "file-transcription",
]);

const INTEGER_RANGES = {
  step: [1, 20],
  step_count: [1, 20],
  words_added: [0, 1_000_000_000],
  words_used: [0, 1_000_000_000],
  daily_limit: [0, 1_000_000_000],
  realtime_factor_x100: [1, 1_000_000],
};

function sanitizeAnalyticsProperties(properties) {
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) {
    return {};
  }

  const safe = {};
  for (const [key, value] of Object.entries(properties)) {
    if (!ALLOWED_ANALYTICS_PROPERTY_KEYS.has(key)) {
      continue;
    }

    if (key === "source" && typeof value === "string") {
      safe[key] = ALLOWED_ANALYTICS_SOURCES.has(value) ? value : "unknown";
      continue;
    }

    if (key === "language" && typeof value === "string") {
      // "custom" rather than "unset": an unrecognised code still means the user
      // chose a language, and counting that as auto-detect would hide it.
      safe[key] = ALLOWED_ANALYTICS_LANGUAGES.has(value) ? value : "custom";
      continue;
    }

    if (key === "model" && typeof value === "string") {
      safe[key] = ALLOWED_ANALYTICS_MODELS.has(value) ? value : "custom";
      continue;
    }

    if (STRING_ENUMS[key]?.has(value)) {
      safe[key] = value;
      continue;
    }

    const range = INTEGER_RANGES[key];
    if (range && Number.isInteger(value) && value >= range[0] && value <= range[1]) {
      safe[key] = value;
      continue;
    }

    if (key === "limit_reached" && typeof value === "boolean") {
      safe[key] = value;
    }
  }

  return safe;
}

function isAllowedAnalyticsEvent(event) {
  return typeof event === "string" && ALLOWED_ANALYTICS_EVENTS.has(event);
}

module.exports = {
  ALLOWED_ANALYTICS_EVENTS,
  ALLOWED_ANALYTICS_LANGUAGES,
  ALLOWED_ANALYTICS_MODELS,
  ALLOWED_ANALYTICS_PROPERTY_KEYS,
  ALLOWED_ANALYTICS_SOURCES,
  isAllowedAnalyticsEvent,
  sanitizeAnalyticsProperties,
};
