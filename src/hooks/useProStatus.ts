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

// Features that require a Pro entitlement (controls lock gating)
const PRO_FEATURES = new Set([
  "correction-memory",
  "smart-context",
  "action-engine",
  "ai-enhancement",
  "voice-assistant",
]);

// Subset of PRO_FEATURES that also carry a visible badge in the sidebar/page headers
const SIDEBAR_PRO_ITEMS = new Set(["correction-memory", "ai-enhancement", "voice-assistant", "action-engine"]);

// localStorage key and custom event used by the temporary preview toggle
const PREVIEW_KEY = "privatetranscribe_pro_preview";
const PREVIEW_EVENT = "privatetranscribe-pro-preview-changed";

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
// Pro Preview - temporary internal toggle (not part of public paywall arch)
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

// ─────────────────────────────────────────────────────────────────────────────
// Effective Entitlement - single source of truth for all gating + badge logic
// ─────────────────────────────────────────────────────────────────────────────

/**
 * [TEMPORARY - dev/internal override only]
 *
 * Returns the effective entitlement used by all feature gating and badge
 * rendering.  Resolution order:
 *   1. Internal override (Pro Preview toggle in Developer Settings)
 *   2. Real Pro license (verified token + status flag)
 *   3. Dev mode with enforcement disabled → treat as Pro so contributors
 *      can work without a license
 *   4. Default → Free
 *
 * This is the ONLY place entitlement resolution logic should live.
 * `isFeatureUnlocked()` and `shouldShowProBadge()` both delegate here.
 */
export function getEffectiveEntitlement(): "free" | "pro" {
  // 1. Internal override (Pro Preview toggle)
  const preview = getProPreview();
  if (preview === "pro") return "pro";
  if (preview === "free") return "free";

  // 2. Dev mode - contributors get Pro access without a license
  if (!isProEnforcementEnabled()) return "pro";

  // 3. Real license - dual check: status flag + tamper-resistant token
  const status = getProStatus();
  if (status.isPro && _verifyToken(status._t)) return "pro";

  // 4. Default
  return "free";
}

/**
 * Whether to show a "Pro" badge on a sidebar/page-header item.
 * Badges are hidden once the effective entitlement is Pro (visual clutter).
 */
export function shouldShowProBadge(featureId: string): boolean {
  if (!SIDEBAR_PRO_ITEMS.has(featureId)) return false;
  return getEffectiveEntitlement() === "free";
}

/**
 * Whether a Pro-gated feature is accessible.
 * Non-Pro features always return true.  Pro features gate on effective entitlement.
 */
export function isFeatureUnlocked(featureId: string): boolean {
  if (!PRO_FEATURES.has(featureId)) return true;
  return getEffectiveEntitlement() === "pro";
}
