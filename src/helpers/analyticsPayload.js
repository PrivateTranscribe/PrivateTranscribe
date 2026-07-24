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

const MAX_STRING_LENGTH = 80;
const MAX_NUMBER_MAGNITUDE = 1_000_000_000;

function sanitizeAnalyticsProperties(properties) {
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) {
    return {};
  }

  const safe = {};
  for (const [key, value] of Object.entries(properties)) {
    if (!ALLOWED_ANALYTICS_PROPERTY_KEYS.has(key)) {
      continue;
    }

    if (typeof value === "string") {
      safe[key] = value.slice(0, MAX_STRING_LENGTH);
      continue;
    }

    if (typeof value === "boolean") {
      safe[key] = value;
      continue;
    }

    if (
      typeof value === "number" &&
      Number.isFinite(value) &&
      Math.abs(value) <= MAX_NUMBER_MAGNITUDE
    ) {
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
