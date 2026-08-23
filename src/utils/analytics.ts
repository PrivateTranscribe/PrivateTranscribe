export type AnalyticsProperties = Record<string, string | number | boolean>;

type AnalyticsTrackResult = {
  sent?: boolean;
  reason?: string;
};

const TRACKED_ONCE_PREFIX = "analyticsTracked:";

export async function trackAnalyticsEvent(
  event: string,
  properties: AnalyticsProperties = {}
): Promise<boolean> {
  try {
    const result = (await window.electronAPI?.analyticsTrack?.(event, properties)) as
      | AnalyticsTrackResult
      | undefined;
    return result?.sent === true;
  } catch {
    return false;
  }
}

export async function trackAnalyticsEventOnce(
  event: string,
  properties: AnalyticsProperties = {}
): Promise<boolean> {
  const marker = `${TRACKED_ONCE_PREFIX}${event}`;

  try {
    if (localStorage.getItem(marker) === "true") {
      return false;
    }
  } catch {
    // Continue without deduplication if storage is unavailable.
  }

  const sent = await trackAnalyticsEvent(event, properties);
  if (sent) {
    try {
      localStorage.setItem(marker, "true");
    } catch {
      // The event was sent successfully; a missing marker only affects future deduplication.
    }
  }
  return sent;
}

function bucketWordCount(text: string) {
  const count = text.trim() ? text.trim().split(/\s+/).length : 0;
  if (count <= 10) return "1-10";
  if (count <= 50) return "11-50";
  if (count <= 200) return "51-200";
  if (count <= 1000) return "201-1000";
  return "1001+";
}

function bucketDuration(durationSeconds: unknown) {
  if (typeof durationSeconds !== "number" || !Number.isFinite(durationSeconds)) return "unknown";
  if (durationSeconds <= 5) return "0-5s";
  if (durationSeconds <= 15) return "6-15s";
  if (durationSeconds <= 60) return "16-60s";
  if (durationSeconds <= 300) return "61-300s";
  return "301s+";
}

/**
 * The language setting, never a detected or inferred one.
 *
 * We report what the user configured, so this stays a coarse product setting
 * rather than a fact derived from the contents of their speech. "auto" is
 * reported as itself, which is the answer we most need: it is the setting
 * that costs accuracy, and we cannot tell how many people sit on it
 * otherwise.
 */
export const ALLOWED_TRANSCRIPTION_ANALYTICS_LANGUAGES = new Set([
  "unset",
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

export const ALLOWED_TRANSCRIPTION_ANALYTICS_SOURCES = new Set([
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

function normalizeLanguageSetting(preferredLanguage: unknown) {
  if (typeof preferredLanguage !== "string") return "unset";
  const normalized = preferredLanguage.trim().toLowerCase();
  return ALLOWED_TRANSCRIPTION_ANALYTICS_LANGUAGES.has(normalized) ? normalized : "unset";
}

function normalizeSource(source: unknown) {
  return typeof source === "string" && ALLOWED_TRANSCRIPTION_ANALYTICS_SOURCES.has(source)
    ? source
    : "unknown";
}

const COMPUTE_MODES = new Set(["cpu", "cuda", "cloud", "mixed", "unknown"]);
const KNOWN_TRANSCRIPTION_MODELS = new Set([
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
  "mixed",
]);

function normalizeComputeMode(computeMode: unknown) {
  return typeof computeMode === "string" && COMPUTE_MODES.has(computeMode)
    ? computeMode
    : "unknown";
}

function normalizeModelSetting(model: unknown) {
  if (typeof model !== "string" || !model.trim()) return "unknown";
  const normalized = model.trim().toLowerCase();
  return KNOWN_TRANSCRIPTION_MODELS.has(normalized) ? normalized : "custom";
}

/**
 * Exact speed to two decimal places, encoded as an integer so both the renderer
 * and Supabase can validate it without accepting arbitrary floating-point data.
 * 3000 means 30.00x real-time. This reuses timings already measured by the
 * transcription pipeline and performs no benchmark, hardware probe, or I/O.
 */
export function computeRealtimeFactorX100(
  durationSeconds: unknown,
  transcriptionProcessingDurationMs: unknown
): number | null {
  if (
    typeof durationSeconds !== "number" ||
    !Number.isFinite(durationSeconds) ||
    durationSeconds <= 0 ||
    typeof transcriptionProcessingDurationMs !== "number" ||
    !Number.isFinite(transcriptionProcessingDurationMs) ||
    transcriptionProcessingDurationMs <= 0
  ) {
    return null;
  }

  const factorX100 = Math.round(
    (durationSeconds / (transcriptionProcessingDurationMs / 1000)) * 100
  );
  return Number.isSafeInteger(factorX100) && factorX100 > 0 ? factorX100 : null;
}

export function buildTranscriptionAnalyticsProperties({
  source,
  outputAction,
  text,
  durationSeconds,
  preferredLanguage,
  model,
  computeMode,
  transcriptionProcessingDurationMs,
}: {
  source?: unknown;
  outputAction: "paste" | "copy" | "action" | "none";
  text: string;
  durationSeconds?: unknown;
  preferredLanguage?: unknown;
  model?: unknown;
  computeMode?: unknown;
  transcriptionProcessingDurationMs?: unknown;
}): AnalyticsProperties {
  const realtimeFactorX100 = computeRealtimeFactorX100(
    durationSeconds,
    transcriptionProcessingDurationMs
  );

  return {
    source: normalizeSource(source),
    output_action: outputAction,
    word_count_bucket: bucketWordCount(text),
    duration_bucket: bucketDuration(durationSeconds),
    // Language and model travel together on purpose. Either alone answers
    // little; together they answer the question that actually drives work,
    // which is how many people are dictating a non-English language on a
    // model that handles it badly.
    language: normalizeLanguageSetting(preferredLanguage),
    model: normalizeModelSetting(model),
    compute_mode: normalizeComputeMode(computeMode),
    ...(realtimeFactorX100 === null ? {} : { realtime_factor_x100: realtimeFactorX100 }),
  };
}
