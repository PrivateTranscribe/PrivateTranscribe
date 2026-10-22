// The main process keeps at most this many history items, whatever is asked.
export const HISTORY_LIMIT_MAX = 100_000;

export type ImportedHistoryLimit = { limit: number } | { skipReason: string };

/**
 * A history limit from a settings file. Lowering the limit deletes the
 * history above it at once, so an import never lowers it: the History limit
 * field asks before it deletes, and the user can lower it there.
 */
export function resolveImportedHistoryLimit(
  value: unknown,
  currentLimit: number
): ImportedHistoryLimit {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    return { skipReason: "must be a whole number, 0 or more" };
  }
  const limit = Math.min(value, HISTORY_LIMIT_MAX);
  if (limit < currentLimit) {
    return {
      skipReason: `${limit} is lower than this PC's ${currentLimit} and would delete history; lower it in Settings, which asks first`,
    };
  }
  return { limit };
}
