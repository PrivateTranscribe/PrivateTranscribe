import { useState, useEffect, useCallback } from "react";
import { getProStatus, refreshProStatus, type ProStatus } from "../services/LicensingService";

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

/**
 * Check if a feature requires Pro and is currently unlocked.
 * For use outside of React components.
 */
export function isFeatureUnlocked(featureId: string): boolean {
  // During development / beta, all features are unlocked.
  // Set this to false when Pro licensing is live.
  const PRO_ENFORCEMENT_ENABLED = false;

  if (!PRO_ENFORCEMENT_ENABLED) return true;

  const PRO_FEATURES = new Set([
    "correction-memory",
    "smart-context",
    "action-engine",
  ]);

  if (!PRO_FEATURES.has(featureId)) return true; // Free feature

  const status = getProStatus();
  return status.isPro;
}
