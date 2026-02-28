import { useState, useEffect, useCallback } from "react";
import { getProStatus, refreshProStatus, _verifyToken, type ProStatus } from "../services/LicensingService";

/**
 * React hook for checking Pro license status.
 * Refreshes on mount and provides helper methods.
 */
export function useProStatus() {
  const [status, setStatus] = useState<ProStatus>(getProStatus());

  useEffect(() => {
    // Refresh from server on mount (if online)
    refreshProStatus().then(setStatus).catch(() => {
      // If refresh fails, use cached
      setStatus(getProStatus());
    });
  }, []);

  const refresh = useCallback(async () => {
    const newStatus = await refreshProStatus();
    setStatus(newStatus);
    return newStatus;
  }, []);

  return {
    ...status,
    refresh,
  };
}

// Pro feature IDs
const PRO_FEATURES = new Set([
  "correction-memory",
  "smart-context",
  "action-engine",
]);

/**
 * Check if a feature requires Pro and is currently unlocked.
 * Uses dual verification: status flag + token integrity.
 */
export function isFeatureUnlocked(featureId: string): boolean {
  // During development / beta, all features are unlocked.
  // Set this to false when Pro licensing is live.
  const PRO_ENFORCEMENT_ENABLED = false;

  if (!PRO_ENFORCEMENT_ENABLED) return true;

  if (!PRO_FEATURES.has(featureId)) return true; // Free feature

  const status = getProStatus();
  // Dual check: isPro flag AND token verification
  return status.isPro && _verifyToken(status._t);
}
