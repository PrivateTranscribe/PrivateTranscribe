/**
 * The notice shown when a dictation goes through without the AI cleanup the user
 * switched on. The raw text is kept; the notice says why it was not
 * cleaned up, once per kind of failure, so a run of offline dictations does
 * not repeat it.
 */

export type CleanupFailureKind =
  "not_set_up" | "auth" | "rate_limit" | "timeout" | "network" | "other";

const PROVIDER_LABELS: Record<string, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  gemini: "Gemini",
  groq: "Groq",
  local: "The local AI model",
  custom: "Your custom endpoint",
  "claude-code": "Claude Code",
};

export function cleanupProviderLabel(provider: string | null | undefined): string {
  return PROVIDER_LABELS[provider || ""] || "The AI provider";
}

/** @returns the kind of failure, or null for a cleanup the user cancelled. */
export function classifyCleanupFailure(error: unknown): CleanupFailureKind | null {
  const err = error as { message?: string; name?: string; status?: number } | null;
  const message = String(err?.message ?? error ?? "");
  const status = typeof err?.status === "number" ? err.status : null;

  if (err?.name === "AbortError" || /cleanup cancelled/i.test(message)) return null;
  if (/api key not configured/i.test(message)) return "not_set_up";
  if (
    status === 401 ||
    status === 403 ||
    /\b40[13]\b|unauthori[sz]ed|invalid.{0,20}(api )?key|incorrect api key|api key.{0,20}(invalid|not valid)|permission denied/i.test(
      message
    )
  ) {
    return "auth";
  }
  if (status === 429 || /\b429\b|rate.?limit|quota|too many requests/i.test(message)) {
    return "rate_limit";
  }
  if (/timed out|timeout/i.test(message)) return "timeout";
  if (
    /failed to fetch|fetch failed|network|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|offline|internet disconnected/i.test(
      message
    )
  ) {
    return "network";
  }
  return "other";
}

export function getCleanupFailureNotice(
  kind: CleanupFailureKind,
  provider: string | null | undefined
): { title: string; description: string } {
  const label = cleanupProviderLabel(provider);
  const title = "AI cleanup skipped";
  switch (kind) {
    case "not_set_up":
      if (provider === "local") {
        return {
          title,
          description: "The local AI model is not ready. Download it in AI Enhancement.",
        };
      }
      if (provider === "claude-code") {
        return { title, description: "Claude Code is not available on this PC right now." };
      }
      return { title, description: `${label} has no API key. Add one in AI Enhancement.` };
    case "auth":
      return { title, description: `${label} refused the API key. Check it in AI Enhancement.` };
    case "rate_limit":
      return { title, description: `${label} is rate limiting you or is out of quota.` };
    case "timeout":
      return { title, description: `${label} did not answer in time.` };
    case "network": {
      const inSentence = /^(The|Your) /.test(label)
        ? label.charAt(0).toLowerCase() + label.slice(1)
        : label;
      return { title, description: `Could not reach ${inSentence}. Check your connection.` };
    }
    default:
      return { title, description: `${label} returned an error. The debug log has the details.` };
  }
}
