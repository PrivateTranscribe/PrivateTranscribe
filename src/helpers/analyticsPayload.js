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
};

const INTEGER_RANGES = {
  step: [1, 20],
  step_count: [1, 20],
  words_added: [0, 1_000_000_000],
  words_used: [0, 1_000_000_000],
  daily_limit: [0, 1_000_000_000],
};

const SOURCE_PATTERN = /^[a-z0-9-]{1,32}$/;

function sanitizeAnalyticsProperties(properties) {
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) {
    return {};
  }

  const safe = {};
  for (const [key, value] of Object.entries(properties)) {
    if (!ALLOWED_ANALYTICS_PROPERTY_KEYS.has(key)) {
      continue;
    }

    if (key === "source" && typeof value === "string" && SOURCE_PATTERN.test(value)) {
      safe[key] = value;
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
  ALLOWED_ANALYTICS_PROPERTY_KEYS,
  isAllowedAnalyticsEvent,
  sanitizeAnalyticsProperties,
};
