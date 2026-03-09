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
  ActionUpdatePayload,
} from "../types/actionEngine";

export interface UseActionEngineResult {
  /** Ordered list of all actions (oldest first, matching DB order). */
  actions: Action[];
  /** True while an initial load or any mutation is in flight. */
  loading: boolean;
  /** Last error message, or null when healthy. */
  error: string | null;

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
}

export function useActionEngine(): UseActionEngineResult {
  const [actions, setActions] = useState<Action[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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
      const result = await window.electronAPI?.actionEngineExecute?.(id);
      return result ?? { success: false, error: "Action Engine unavailable." };
    } catch (err: unknown) {
      return {
        success: false,
        error: err instanceof Error ? err.message : "Execution failed.",
      };
    }
  }, []);

  return {
    actions,
    loading,
    error,
    refresh,
    createAction,
    updateAction,
    deleteAction,
    toggleEnabled,
    executeAction,
  };
}
