import { useLocalStorage } from "../hooks/useLocalStorage";

// Converse, Agent Mode and the Action Engine are less tested, so they stay out
// of sight until "Experimental features" is on. Their own saved settings are
// never rewritten, so turning the switch back on restores them as they were.
export const EXPERIMENTAL_FEATURES_KEY = "experimentalFeatures";
export const AGENT_MODE_ENABLED_KEY = "agentModeDictationEnabled";

const EXPERIMENTAL_PAGES = new Set(["converse", "action-engine"]);
export const EXPERIMENTAL_FALLBACK_PAGE = "home";

const serialize = (value: boolean) => String(value);
const deserialize = (value: string) => value === "true";

export function areExperimentalFeaturesEnabled(): boolean {
  try {
    return localStorage.getItem(EXPERIMENTAL_FEATURES_KEY) === "true";
  } catch {
    return false;
  }
}

export function isExperimentalPage(pageId: string): boolean {
  return EXPERIMENTAL_PAGES.has(pageId);
}

export function resolveExperimentalPage<T extends string>(
  pageId: T,
  experimentalOn: boolean
): T | typeof EXPERIMENTAL_FALLBACK_PAGE {
  return experimentalOn || !isExperimentalPage(pageId) ? pageId : EXPERIMENTAL_FALLBACK_PAGE;
}

/** Agent Mode as it applies to the next dictation: its own setting and the switch. */
export function isAgentModeActive(): boolean {
  try {
    return (
      areExperimentalFeaturesEnabled() && localStorage.getItem(AGENT_MODE_ENABLED_KEY) === "true"
    );
  } catch {
    return false;
  }
}

export function useExperimentalFeatures() {
  return useLocalStorage<boolean>(EXPERIMENTAL_FEATURES_KEY, false, { serialize, deserialize });
}
