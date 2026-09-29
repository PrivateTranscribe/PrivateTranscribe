import { BETA_FEATURES_KEY } from "./betaFeatures";

/** Set once the cleanup has finished, so it never runs again on this PC. */
export const LEGACY_PLAN_CLEANUP_KEY = "legacyPlanCleanupDone";

// What the licence client, the Pro preview and the daily caps kept in
// localStorage. Nothing reads these any more.
const LEGACY_PLAN_KEYS = [
  "privatetranscribe_license_key",
  "privatetranscribe_entitlement",
  "privatetranscribe_pro_status",
  "privatetranscribe_seal",
  "privatetranscribe_ts",
  "privatetranscribe_device_id",
  "privatetranscribe_pro_preview",
  "PRO_ENFORCEMENT",
  "privatetranscribe_starter_usage_v1",
  "privatetranscribe_agent_mode_usage_v1",
];

type PlanStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function wasApprovedTester(storage: PlanStorage): boolean {
  if (storage.getItem("privatetranscribe_pro_status") !== "active") return false;
  try {
    const entitlement = JSON.parse(storage.getItem("privatetranscribe_entitlement") ?? "null");
    return entitlement?.betaAccess === true;
  } catch {
    return false;
  }
}

/**
 * Removes what the paid plan left in localStorage, once. An approved tester
 * gets the beta switch turned on so they keep their features. Both windows
 * run this at startup; every step leads to the same end state.
 */
export function cleanUpLegacyPlanState(storage?: PlanStorage): void {
  try {
    const store = storage ?? globalThis.localStorage;
    if (!store || store.getItem(LEGACY_PLAN_CLEANUP_KEY) === "true") return;

    // Overrides a stored "false": that value may only be the persisted default.
    if (wasApprovedTester(store)) store.setItem(BETA_FEATURES_KEY, "true");
    for (const key of LEGACY_PLAN_KEYS) store.removeItem(key);

    // Last, so a run cut short is simply repeated on the next start.
    store.setItem(LEGACY_PLAN_CLEANUP_KEY, "true");
  } catch {
    // Unreadable storage must never keep the app from starting.
  }
}
