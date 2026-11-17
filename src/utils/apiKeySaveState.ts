import { useSyncExternalStore } from "react";

/**
 * Which API keys this window could not write to disk on their latest save.
 *
 * A key field saves on every keystroke, and several components each hold their
 * own useSettings, so the result lives here, once per window: the card that
 * shows "API key saved" reads it no matter which component made the save.
 */

export type ApiKeyId =
  "openai" | "anthropic" | "gemini" | "groq" | "customTranscription" | "customReasoning";

const unsaved = new Set<ApiKeyId>();
const latestRun = new Map<ApiKeyId, number>();
const listeners = new Set<() => void>();
let snapshot: ReadonlySet<ApiKeyId> = new Set();

function publish() {
  snapshot = new Set(unsaved);
  for (const listener of listeners) listener();
}

/** Start a save of this key. Returns a token that only the latest save holds. */
export function beginApiKeySave(id: ApiKeyId): number {
  const run = (latestRun.get(id) ?? 0) + 1;
  latestRun.set(id, run);
  return run;
}

/**
 * Record how a save ended. A result from a save that a later one replaced is
 * ignored. Returns whether this was the latest save.
 */
export function finishApiKeySave(id: ApiKeyId, run: number, saved: boolean): boolean {
  if (latestRun.get(id) !== run) return false;
  if (saved === !unsaved.has(id)) return true;
  if (saved) unsaved.delete(id);
  else unsaved.add(id);
  publish();
  return true;
}

/** Whether this key's latest save did not reach the disk. */
export function isApiKeyUnsaved(id: ApiKeyId): boolean {
  return snapshot.has(id);
}

/** Call `listener` whenever a key turns saved or unsaved. Returns the unsubscribe. */
export function subscribeApiKeySaves(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The keys whose latest save did not reach the disk. */
export function useUnsavedApiKeys(): ReadonlySet<ApiKeyId> {
  return useSyncExternalStore(subscribeApiKeySaves, () => snapshot);
}
