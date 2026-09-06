import { useState, useEffect } from "react";
import { getProStatus, _verifyToken } from "../services/LicensingService";

// Unfinished workflow features that require approved tester access.
//
// There is no "voice-assistant" entry any more: the assistant name and Prompt
// Studio moved into the AI Enhancement page, so they gate on "ai-enhancement".
// Nothing per-feature is persisted — every id here resolves through the one
// `hasTesterAccess()` entitlement — so an existing tester keeps exactly the
// access they had.
const BETA_FEATURES = new Set([
  "correction-memory",
  "smart-context",
  "action-engine",
  "ai-enhancement",
  "read-aloud",
]);

// Shipped Pro features: unlocked by the paid entitlement alone, no tester flag.
// A paying customer who was never approved as a tester still gets these, and
// everyone else sees the feature's own locked state rather than nothing.
const PRO_FEATURES = new Set(["converse"]);

// Subset of beta features that carry a visible badge in sidebar/page headers.
// "correction-memory" is deliberately absent: it has no sidebar item of its
// own (its page renders embedded inside Dictionary, which carries no badge),
// so there is nothing for shouldShowProBadge("correction-memory") to badge.
// It stays in BETA_FEATURES above because the feature gate itself is alive.
const SIDEBAR_BETA_ITEMS = new Set([
  "ai-enhancement",
  "action-engine",
  // Read Aloud used to be a Settings tab, where nobody found it. It is a
  // sidebar page now, so it carries the same badge as every other beta item.
  "read-aloud",
]);

// localStorage key and custom event used by the temporary preview toggle
const PREVIEW_KEY = "privatetranscribe_pro_preview";
const PREVIEW_EVENT = "privatetranscribe-pro-preview-changed";

function isProductionBuild(): boolean {
  // Keep this as a direct Vite constant access. The previous dynamic
  // import-meta object lookup survived into the bundled Electron app,
  // where `import.meta.env` is undefined at runtime; that made packaged builds
  // look like development and unlocked Pro by default.
  return import.meta.env.PROD === true;
}

function isProEnforcementEnabled(): boolean {
  // Production builds always enforce licensing. localStorage is user-controlled
  // in the renderer, so QA/dev overrides must never unlock shipped builds.
  if (isProductionBuild()) return true;

  // Development/staging override:
  // - localStorage.PRO_ENFORCEMENT = "true" | "false"
  try {
    const override = localStorage.getItem("PRO_ENFORCEMENT");
    if (override === "true") return true;
    if (override === "false") return false;
  } catch {
    // ignore
  }

  // DEV remains unlocked by default so contributors can test without licenses.
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pro Preview - temporary internal toggle (not part of public paywall arch)
// Lets Kristian preview Free vs Pro UI state without changing the real license.
// ─────────────────────────────────────────────────────────────────────────────

export type ProPreviewMode = "free" | "pro" | "tester" | null;

/** Read the current preview override from localStorage. */
export function getProPreview(): ProPreviewMode {
  if (isProductionBuild()) return null;

  try {
    const val = localStorage.getItem(PREVIEW_KEY);
    if (val === "free" || val === "pro" || val === "tester") return val;
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
  if (preview === "pro" || preview === "tester") return "pro";
  if (preview === "free") return "free";

  // 2. Dev mode - contributors get Pro access without a license
  if (!isProEnforcementEnabled()) return "pro";

  // 3. Real license - dual check: status flag + tamper-resistant token
  const status = getProStatus();
  if (status.isPro && _verifyToken(status._t)) return "pro";

  // 4. Default
  return "free";
}

/** Whether the current entitlement may use unfinished tester-only workflows. */
export function hasTesterAccess(): boolean {
  const preview = getProPreview();
  if (preview === "tester") return true;
  if (preview === "free" || preview === "pro") return false;

  const status = getProStatus();
  if (status.isPro && status.betaAccess === true && _verifyToken(status._t)) return true;

  // Development gets stable Pro behavior by default, but unfinished features
  // require either a real tester entitlement or the explicit Tester preview.
  return false;
}

/**
 * Whether to show a locked badge on a sidebar/page-header item.
 * Pro features badge until the paid entitlement is active; beta features badge
 * until approved tester access is active.
 */
export function shouldShowProBadge(featureId: string): boolean {
  if (PRO_FEATURES.has(featureId)) return getEffectiveEntitlement() !== "pro";
  if (!SIDEBAR_BETA_ITEMS.has(featureId)) return false;
  return !hasTesterAccess();
}

/**
 * Whether a gated feature is accessible.
 * Pro features require the paid entitlement. Beta features require approved
 * tester access. Everything else is always true.
 */
export function isFeatureUnlocked(featureId: string): boolean {
  if (PRO_FEATURES.has(featureId)) return getEffectiveEntitlement() === "pro";
  if (!BETA_FEATURES.has(featureId)) return true;
  return hasTesterAccess();
}
