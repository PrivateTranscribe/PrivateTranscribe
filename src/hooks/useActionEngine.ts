/**
 * useActionEngine — React hook for Action Engine CRUD.
 *
 * Wraps the electronAPI action engine calls with loading / error state and
 * provides a stable, typed interface for UI components.
 */

import { useCallback, useEffect, useState } from "react";
import type {
  Action,
  ActionCreatePayload,
  ActionExecuteResult,
  ActionRun,
  ActionUpdatePayload,
} from "../types/actionEngine";

/** localStorage key that stores the global Action Engine kill-switch state. */
export const ACTION_ENGINE_ENABLED_KEY = "actionEngineEnabled";

/** localStorage key that stores the run-history retention limit. */
export const RUNS_RETENTION_LIMIT_KEY = "actionEngineRunsRetentionLimit";

/**
 * Pure helper — resolves whether the Action Engine is globally enabled from a
 * raw localStorage value.  A missing / null value defaults to `true` (opt-in
 * is already done at the feature-unlock level); only the explicit string
 * `"false"` disables it.
 */
export function resolveActionEngineEnabled(raw: string | null): boolean {
  return raw !== "false";
}

/**
 * Pure helper — resolves the run-history retention limit from a raw localStorage
 * value.  Returns 0 for "unlimited" (the default when the value is missing or
 * invalid).  Any stored positive integer is returned as-is.
 */
export function resolveRunsRetentionLimit(raw: string | null): number {
  const n = parseInt(raw ?? "", 10);
  return isNaN(n) || n < 0 ? 0 : n;
}

export interface UseActionEngineResult {
  /** Ordered list of all actions (oldest first, matching DB order). */
  actions: Action[];
  /** True while an initial load or any mutation is in flight. */
  loading: boolean;
  /** Last error message, or null when healthy. */
  error: string | null;

  /** Whether the Action Engine is globally enabled (kill-switch state). */
  globalEnabled: boolean;
  /** Toggle the global kill-switch and persist to localStorage. */
  setGlobalEnabled: (enabled: boolean) => void;

  /** Re-fetch the action list from the main process. */
  refresh: () => Promise<void>;

  /** Create a new action. Returns the created action on success. */
  createAction: (payload: ActionCreatePayload) => Promise<Action | null>;

  /** Partially update an action. Returns the updated action on success. */
  updateAction: (id: string, patch: ActionUpdatePayload) => Promise<Action | null>;

  /** Permanently delete an action. */
  deleteAction: (id: string) => Promise<boolean>;

  /** Enable or disable an action without opening the edit dialog. */
  toggleEnabled: (id: string, enabled: boolean) => Promise<Action | null>;

  /**
   * Execute an action by ID.
   * Returns the execution result without throwing (errors surfaced via result.error).
   */
  executeAction: (id: string) => Promise<ActionExecuteResult>;

  // ── Run History ────────────────────────────────────────────────────────────

  /** Recent action runs (newest first). */
  runs: ActionRun[];
  /** True while runs are being fetched. */
  runsLoading: boolean;

  /** Fetch the most recent `limit` runs (default 50). */
  loadRuns: (limit?: number) => Promise<void>;

  /** Permanently delete all run history records. */
  clearRuns: () => Promise<boolean>;

  /**
   * Maximum number of run records to retain in the database.
   * 0 means unlimited (no automatic pruning).
   */
  runsRetentionLimit: number;
  /** Persist a new retention limit and immediately prune older runs. */
  setRunsRetentionLimit: (limit: number) => Promise<void>;
  /** Explicitly prune old runs to the given limit. 0 = unlimited (no-op). */
  pruneRuns: (maxRuns: number) => Promise<{ success: boolean; pruned?: number }>;
}

export function useActionEngine(): UseActionEngineResult {
  const [actions, setActions] = useState<Action[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [runs, setRuns] = useState<ActionRun[]>([]);
  const [runsLoading, setRunsLoading] = useState(false);
  const [globalEnabled, setGlobalEnabledState] = useState<boolean>(() =>
    resolveActionEngineEnabled(localStorage.getItem(ACTION_ENGINE_ENABLED_KEY))
  );
  const [runsRetentionLimit, setRunsRetentionLimitState] = useState<number>(() =>
    resolveRunsRetentionLimit(localStorage.getItem(RUNS_RETENTION_LIMIT_KEY))
  );

  const setGlobalEnabled = useCallback((enabled: boolean) => {
    localStorage.setItem(ACTION_ENGINE_ENABLED_KEY, enabled ? "true" : "false");
    setGlobalEnabledState(enabled);
  }, []);

  const refresh = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const result = await window.electronAPI?.actionEngineList?.();
      if (result?.success && Array.isArray(result.actions)) {
        setActions(result.actions);
      } else {
        setError(result?.error ?? "Failed to load actions.");
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load actions.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const createAction = useCallback(async (payload: ActionCreatePayload): Promise<Action | null> => {
    try {
      setError(null);
      const result = await window.electronAPI?.actionEngineCreate?.(payload);
      if (result?.success && result.action) {
        setActions((prev) => [...prev, result.action!]);
        return result.action;
      }
      setError(result?.error ?? "Failed to create action.");
      return null;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to create action.";
      setError(msg);
      return null;
    }
  }, []);

  const updateAction = useCallback(
    async (id: string, patch: ActionUpdatePayload): Promise<Action | null> => {
      try {
        setError(null);
        const result = await window.electronAPI?.actionEngineUpdate?.(id, patch);
        if (result?.success && result.action) {
          setActions((prev) => prev.map((a) => (a.id === id ? result.action! : a)));
          return result.action;
        }
        setError(result?.error ?? "Failed to update action.");
        return null;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "Failed to update action.";
        setError(msg);
        return null;
      }
    },
    []
  );

  const deleteAction = useCallback(async (id: string): Promise<boolean> => {
    try {
      setError(null);
      const result = await window.electronAPI?.actionEngineDelete?.(id);
      if (result?.success) {
        setActions((prev) => prev.filter((a) => a.id !== id));
        return true;
      }
      setError(result?.error ?? "Failed to delete action.");
      return false;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to delete action.";
      setError(msg);
      return false;
    }
  }, []);

  const toggleEnabled = useCallback(
    async (id: string, enabled: boolean): Promise<Action | null> => {
      try {
        setError(null);
        const result = await window.electronAPI?.actionEngineToggle?.(id, enabled);
        if (result?.success && result.action) {
          setActions((prev) => prev.map((a) => (a.id === id ? result.action! : a)));
          return result.action;
        }
        setError(result?.error ?? "Failed to toggle action.");
        return null;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "Failed to toggle action.";
        setError(msg);
        return null;
      }
    },
    []
  );

  const executeAction = useCallback(async (id: string): Promise<ActionExecuteResult> => {
    try {
      const result = await window.electronAPI?.actionEngineExecute?.(id, { triggeredBy: "manual" });
      return result ?? { success: false, error: "Action Engine unavailable." };
    } catch (err: unknown) {
      return {
        success: false,
        error: err instanceof Error ? err.message : "Execution failed.",
      };
    }
  }, []);

  const loadRuns = useCallback(async (limit = 50): Promise<void> => {
    try {
      setRunsLoading(true);
      const result = await window.electronAPI?.actionEngineRunsList?.(limit);
      if (result?.success && Array.isArray(result.runs)) {
        setRuns(result.runs);
      }
    } catch {
      // Non-fatal: run history is observability-only.
    } finally {
      setRunsLoading(false);
    }
  }, []);

  const clearRuns = useCallback(async (): Promise<boolean> => {
    try {
      const result = await window.electronAPI?.actionEngineRunsClear?.();
      if (result?.success) {
        setRuns([]);
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }, []);

  const pruneRuns = useCallback(
    async (maxRuns: number): Promise<{ success: boolean; pruned?: number }> => {
      try {
        const result = await window.electronAPI?.actionEngineRunsPrune?.(maxRuns);
        return result ?? { success: false };
      } catch {
        return { success: false };
      }
    },
    []
  );

  const setRunsRetentionLimit = useCallback(
    async (limit: number): Promise<void> => {
      const safeLimit = Math.max(0, Math.round(limit));
      localStorage.setItem(RUNS_RETENTION_LIMIT_KEY, String(safeLimit));
      setRunsRetentionLimitState(safeLimit);
      // Immediately prune to the new limit so the DB stays consistent.
      if (safeLimit > 0) {
        await pruneRuns(safeLimit);
        // Re-fetch so the UI reflects what was pruned.
        await loadRuns(safeLimit);
      }
    },
    [pruneRuns, loadRuns]
  );

  return {
    actions,
    loading,
    error,
    globalEnabled,
    setGlobalEnabled,
    refresh,
    createAction,
    updateAction,
    deleteAction,
    toggleEnabled,
    executeAction,
    runs,
    runsLoading,
    loadRuns,
    clearRuns,
    runsRetentionLimit,
    setRunsRetentionLimit,
    pruneRuns,
  };
}
