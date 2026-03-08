import { useState, useEffect, useCallback } from "react";
import {
  getProStatus,
  refreshProStatus,
  _verifyToken,
  type ProStatus,
} from "../services/LicensingService";

/**
 * React hook for checking Pro license status.
 * Refreshes on mount and provides helper methods.
 */
export function useProStatus() {
  const [status, setStatus] = useState<ProStatus>(getProStatus());

  useEffect(() => {
    // Refresh from server on mount (if online)
    refreshProStatus()
      .then(setStatus)
      .catch(() => {
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

// Pro feature IDs (hard enforcement gate)
const PRO_FEATURES = new Set(["correction-memory", "smart-context", "action-engine"]);

// Items that carry a "Pro" badge in the sidebar / page headers
const SIDEBAR_PRO_ITEMS = new Set(["ai-enhancement", "voice-assistant", "action-engine"]);

// localStorage key and custom event used by the temporary preview toggle
const PREVIEW_KEY = "privoca_pro_preview";
const PREVIEW_EVENT = "privoca-pro-preview-changed";

function isProEnforcementEnabled(): boolean {
  // Default behavior:
  // - DEV: unlocked (so contributors can test without licenses)
  // - PROD: enforced
  //
  // Override (for QA / staging):
  // - localStorage.PRO_ENFORCEMENT = "true" | "false"
  try {
    const override = localStorage.getItem("PRO_ENFORCEMENT");
    if (override === "true") return true;
    if (override === "false") return false;
  } catch {
    // ignore
  }

  // Vite injects these flags.
  try {
    return !!import.meta.env.PROD;
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Pro Preview — temporary internal toggle (not part of public paywall arch)
// Lets Kristian preview Free vs Pro UI state without changing the real license.
// ─────────────────────────────────────────────────────────────────────────────

export type ProPreviewMode = "free" | "pro" | null;

/** Read the current preview override from localStorage. */
export function getProPreview(): ProPreviewMode {
  try {
    const val = localStorage.getItem(PREVIEW_KEY);
    if (val === "free" || val === "pro") return val;
  } catch {
    // ignore
  }
  return null;
}

/** Persist the preview override and notify all active listeners. */
export function setProPreview(mode: ProPreviewMode): void {
  try {
    if (mode === null) {
      localStorage.removeItem(PREVIEW_KEY);
    } else {
      localStorage.setItem(PREVIEW_KEY, mode);
    }
    window.dispatchEvent(new CustomEvent(PREVIEW_EVENT, { detail: mode }));
  } catch {
    // ignore
  }
}

/**
 * React hook that tracks the Pro preview mode and re-renders whenever it
 * changes (e.g. from the Developer Tools toggle).
 */
export function useProPreview(): [ProPreviewMode, (mode: ProPreviewMode) => void] {
  const [preview, setPreviewState] = useState<ProPreviewMode>(getProPreview);

  useEffect(() => {
    const handler = () => setPreviewState(getProPreview());
    window.addEventListener(PREVIEW_EVENT, handler);
    return () => window.removeEventListener(PREVIEW_EVENT, handler);
  }, []);

  return [preview, setProPreview];
}

/**
 * Whether to show a "Pro" badge/label on a given sidebar or page-header item.
 *
 * - Pro preview (or real Pro license) → false  — badges are visual clutter once unlocked
 * - Free preview → true                        — badges serve as upsell indicators
 * - Default (no preview, DEV)  → true          — preserves existing visual behavior
 * - Default (no preview, PROD) → depends on actual license
 */
export function shouldShowProBadge(featureId: string): boolean {
  if (!SIDEBAR_PRO_ITEMS.has(featureId)) return false;

  const preview = getProPreview();
  if (preview === "pro") return false;
  if (preview === "free") return true;

  // Default: keep existing behavior — show badge unless user has a verified Pro license
  if (!isProEnforcementEnabled()) return true; // DEV: always show (current static behavior)
  const status = getProStatus();
  return !(status.isPro && _verifyToken(status._t));
}

/**
 * Check if a feature requires Pro and is currently unlocked.
 * Uses dual verification: status flag + token integrity.
 * Respects the Pro preview override so Free/Pro UI states can be previewed.
 */
export function isFeatureUnlocked(featureId: string): boolean {
  const preview = getProPreview();
  if (preview === "pro") return true;
  if (preview === "free" && PRO_FEATURES.has(featureId)) return false;

  if (!isProEnforcementEnabled()) return true;
  if (!PRO_FEATURES.has(featureId)) return true; // Free feature

  const status = getProStatus();
  // Dual check: isPro flag AND token verification
  return status.isPro && _verifyToken(status._t);
}
