/**
 * Action Engine — shared TypeScript types.
 *
 * These types are used by both the renderer (React UI, hooks) and the main
 * process (via JSDoc annotations in actionEngineManager.js).  Keep this file
 * free of Electron / Node imports so it can be imported anywhere.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Core domain types
// ─────────────────────────────────────────────────────────────────────────────

/** How a trigger phrase is compared against the transcribed text. */
export type TriggerMode = "exact" | "prefix" | "contains" | "regex";

/** What the action does when triggered. */
export type ActionType = "shell" | "url" | "app" | "dictation-mode";

/**
 * Type-discriminated config for each action type.
 * Only the fields relevant to `actionType` will be populated.
 */
export interface ActionConfig {
  /** `shell` — command string passed to execFile after tokenization. */
  command?: string;
  /** `url` — http/https URL opened via shell.openExternal(). */
  url?: string;
  /** `app` — file system path opened via shell.openPath(). */
  appPath?: string;
  /** `dictation-mode` — internal mode name sent to the renderer. */
  mode?: string;
}

/** A fully hydrated action as stored in the database. */
export interface Action {
  id: string;
  name: string;
  description: string;
  triggerPhrase: string;
  triggerMode: TriggerMode;
  actionType: ActionType;
  actionConfig: ActionConfig;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Payload types (used by create / update calls)
// ─────────────────────────────────────────────────────────────────────────────

/** Fields required when creating a new action. */
export type ActionCreatePayload = Omit<Action, "id" | "createdAt" | "updatedAt">;

/** Fields that may be partially updated. */
export type ActionUpdatePayload = Partial<ActionCreatePayload>;

// ─────────────────────────────────────────────────────────────────────────────
// Result types
// ─────────────────────────────────────────────────────────────────────────────

/** Returned when a transcript matches one or more actions. */
export interface ActionMatchResult {
  action: Action;
  matchedText: string;
}

/** Returned after attempting to execute an action. */
export interface ActionExecuteResult {
  success: boolean;
  /** Stdout / informational output (if any). */
  output?: string;
  /** Human-readable error message if `success` is false. */
  error?: string;
}
