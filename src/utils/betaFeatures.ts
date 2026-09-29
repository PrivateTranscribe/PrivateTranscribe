import { useLocalStorage } from "../hooks/useLocalStorage";

// Unfinished features stay off until the user turns on "Beta features" in
// Settings. The switch lives only on this PC; nothing checks it remotely.
export const BETA_FEATURES_KEY = "betaFeaturesEnabled";

const BETA_FEATURES = new Set([
  "correction-memory",
  "smart-context",
  "action-engine",
  "ai-enhancement",
]);

// Module-level so useLocalStorage's listener effect does not re-subscribe on
// every render.
const serialize = (value: boolean) => String(value);
const deserialize = (value: string) => value === "true";

export function areBetaFeaturesEnabled(): boolean {
  try {
    return localStorage.getItem(BETA_FEATURES_KEY) === "true";
  } catch {
    return false;
  }
}

export function isBetaFeature(featureId: string): boolean {
  return BETA_FEATURES.has(featureId);
}

/** Whether a feature may run. Only the beta features depend on the switch. */
export function isFeatureUnlocked(featureId: string): boolean {
  return !BETA_FEATURES.has(featureId) || areBetaFeaturesEnabled();
}

/** The switch as React state, kept in sync across windows. */
export function useBetaFeaturesEnabled() {
  return useLocalStorage<boolean>(BETA_FEATURES_KEY, false, { serialize, deserialize });
}
