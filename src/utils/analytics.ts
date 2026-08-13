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
function normalizeLanguageSetting(preferredLanguage: unknown) {
  if (typeof preferredLanguage !== "string") return "unset";
  const normalized = preferredLanguage.trim().toLowerCase();
  if (!normalized) return "unset";
  return normalized;
}

export function buildTranscriptionAnalyticsProperties({
  source,
  outputAction,
  text,
  durationSeconds,
  preferredLanguage,
  model,
}: {
  source?: unknown;
  outputAction: "paste" | "copy" | "action" | "none";
  text: string;
  durationSeconds?: unknown;
  preferredLanguage?: unknown;
  model?: unknown;
}): AnalyticsProperties {
  return {
    source: typeof source === "string" ? source : "unknown",
    output_action: outputAction,
    word_count_bucket: bucketWordCount(text),
    duration_bucket: bucketDuration(durationSeconds),
    // Language and model travel together on purpose. Either alone answers
    // little; together they answer the question that actually drives work,
    // which is how many people are dictating a non-English language on a
    // model that handles it badly.
    language: normalizeLanguageSetting(preferredLanguage),
    model: typeof model === "string" && model ? model : "unknown",
  };
}
