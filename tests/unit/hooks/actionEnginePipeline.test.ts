/**
 * Tests for the Action Engine ↔ transcription pipeline integration.
 *
 * The core integration lives in `useAudioRecording.js` (onTranscriptionComplete
 * callback).  Because that hook has deep Electron/DOM dependencies, we test the
 * pipeline *decision logic* here by reimplementing the branching in a plain
 * function and verifying it behaves correctly for all IPC response shapes.
 *
 * If the inline logic in useAudioRecording.js changes, update this test to match.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ActionMatchResult } from "../../../src/types/actionEngine";

// ─────────────────────────────────────────────────────────────────────────────
// Inline reimplementation of the pipeline decision block
// (mirrors the logic inside onTranscriptionComplete in useAudioRecording.js)
// ─────────────────────────────────────────────────────────────────────────────

interface MatchApiResult {
  success: boolean;
  matches?: ActionMatchResult[];
  error?: string;
}

interface ExecApiResult {
  success: boolean;
  output?: string;
  error?: string;
}

interface MockElectronAPI {
  actionEngineMatch?: (text: string) => Promise<MatchApiResult>;
  actionEngineExecute?: (id: string) => Promise<ExecApiResult>;
}

interface PipelineResult {
  actionHandled: boolean;
  executedIds: string[];
  toasts: Array<{ title: string; variant?: string }>;
}

/**
 * Simulates the action engine block from onTranscriptionComplete.
 * Returns which actions were executed and whether paste was suppressed.
 */
async function runActionEnginePipeline(
  text: string,
  electronAPI: MockElectronAPI | undefined
): Promise<PipelineResult> {
  const executedIds: string[] = [];
  const toasts: Array<{ title: string; variant?: string }> = [];

  let actionHandled = false;
  try {
    if (electronAPI?.actionEngineMatch) {
      const matchResult = await electronAPI.actionEngineMatch(text);
      if (
        matchResult?.success &&
        Array.isArray(matchResult.matches) &&
        matchResult.matches.length > 0
      ) {
        actionHandled = true;
        for (const { action } of matchResult.matches) {
          // eslint-disable-next-line no-await-in-loop
          const execResult = await electronAPI?.actionEngineExecute?.(action.id);
          if (execResult && !execResult.success) {
            toasts.push({ title: `Action failed: ${action.name}`, variant: "destructive" });
          }
          executedIds.push(action.id);
        }
        const names = matchResult.matches.map(({ action }) => action.name).join(", ");
        toasts.push({ title: "Action triggered", variant: "default" });
        void names; // used in production for description
      }
    }
  } catch {
    // Non-fatal: fall through
  }

  return { actionHandled, executedIds, toasts };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeMatchResult(ids: string[]): MatchApiResult {
  return {
    success: true,
    matches: ids.map((id) => ({
      action: {
        id,
        name: `Action ${id}`,
        description: "",
        triggerPhrase: "trigger",
        triggerMode: "exact" as const,
        actionType: "shell" as const,
        actionConfig: { command: "echo ok" },
        enabled: true,
        createdAt: "",
        updatedAt: "",
      },
      matchedText: "trigger",
    })),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests: paste-suppression (actionHandled)
// ─────────────────────────────────────────────────────────────────────────────

describe("action engine pipeline — paste suppression", () => {
  it("suppresses paste when one action matches", async () => {
    const api: MockElectronAPI = {
      actionEngineMatch: vi.fn().mockResolvedValue(makeMatchResult(["a1"])),
      actionEngineExecute: vi.fn().mockResolvedValue({ success: true }),
    };

    const result = await runActionEnginePipeline("open terminal", api);

    expect(result.actionHandled).toBe(true);
  });

  it("suppresses paste when multiple actions match", async () => {
    const api: MockElectronAPI = {
      actionEngineMatch: vi.fn().mockResolvedValue(makeMatchResult(["a1", "a2"])),
      actionEngineExecute: vi.fn().mockResolvedValue({ success: true }),
    };

    const result = await runActionEnginePipeline("open terminal", api);

    expect(result.actionHandled).toBe(true);
    expect(result.executedIds).toEqual(["a1", "a2"]);
  });

  it("does NOT suppress paste when no actions match", async () => {
    const api: MockElectronAPI = {
      actionEngineMatch: vi.fn().mockResolvedValue({ success: true, matches: [] }),
      actionEngineExecute: vi.fn(),
    };

    const result = await runActionEnginePipeline("hello world", api);

    expect(result.actionHandled).toBe(false);
    expect(result.executedIds).toHaveLength(0);
  });

  it("does NOT suppress paste when match returns success: false", async () => {
    const api: MockElectronAPI = {
      actionEngineMatch: vi.fn().mockResolvedValue({ success: false }),
      actionEngineExecute: vi.fn(),
    };

    const result = await runActionEnginePipeline("open terminal", api);

    expect(result.actionHandled).toBe(false);
  });

  it("does NOT suppress paste when actionEngineMatch is unavailable", async () => {
    const api: MockElectronAPI = { actionEngineExecute: vi.fn() };

    const result = await runActionEnginePipeline("open terminal", api);

    expect(result.actionHandled).toBe(false);
  });

  it("does NOT suppress paste when electronAPI is undefined", async () => {
    const result = await runActionEnginePipeline("open terminal", undefined);

    expect(result.actionHandled).toBe(false);
  });

  it("does NOT suppress paste when actionEngineMatch throws (non-fatal fallthrough)", async () => {
    const api: MockElectronAPI = {
      actionEngineMatch: vi.fn().mockRejectedValue(new Error("IPC bridge unavailable")),
      actionEngineExecute: vi.fn(),
    };

    const result = await runActionEnginePipeline("open terminal", api);

    expect(result.actionHandled).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests: execution behaviour
// ─────────────────────────────────────────────────────────────────────────────

describe("action engine pipeline — execution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls actionEngineExecute with the matched action id", async () => {
    const execMock = vi.fn().mockResolvedValue({ success: true });
    const api: MockElectronAPI = {
      actionEngineMatch: vi.fn().mockResolvedValue(makeMatchResult(["abc-123"])),
      actionEngineExecute: execMock,
    };

    await runActionEnginePipeline("open terminal", api);

    expect(execMock).toHaveBeenCalledOnce();
    expect(execMock).toHaveBeenCalledWith("abc-123");
  });

  it("executes all matched actions in order", async () => {
    const calls: string[] = [];
    const execMock = vi.fn().mockImplementation((id: string) => {
      calls.push(id);
      return Promise.resolve({ success: true });
    });

    const api: MockElectronAPI = {
      actionEngineMatch: vi.fn().mockResolvedValue(makeMatchResult(["first", "second", "third"])),
      actionEngineExecute: execMock,
    };

    await runActionEnginePipeline("trigger", api);

    expect(calls).toEqual(["first", "second", "third"]);
  });

  it("shows a destructive toast when an action execution fails", async () => {
    const api: MockElectronAPI = {
      actionEngineMatch: vi.fn().mockResolvedValue(makeMatchResult(["fail-id"])),
      actionEngineExecute: vi
        .fn()
        .mockResolvedValue({ success: false, error: "Command not found" }),
    };

    const result = await runActionEnginePipeline("trigger", api);

    expect(result.toasts.some((t) => t.variant === "destructive")).toBe(true);
    expect(result.toasts.some((t) => t.title.includes("Action failed"))).toBe(true);
  });

  it("still shows 'Action triggered' toast even when one execution fails", async () => {
    const api: MockElectronAPI = {
      actionEngineMatch: vi.fn().mockResolvedValue(makeMatchResult(["id"])),
      actionEngineExecute: vi.fn().mockResolvedValue({ success: false, error: "oops" }),
    };

    const result = await runActionEnginePipeline("trigger", api);

    expect(result.actionHandled).toBe(true);
    expect(result.toasts.some((t) => t.title === "Action triggered")).toBe(true);
  });

  it("does not call execute when no actions match", async () => {
    const execMock = vi.fn();
    const api: MockElectronAPI = {
      actionEngineMatch: vi.fn().mockResolvedValue({ success: true, matches: [] }),
      actionEngineExecute: execMock,
    };

    await runActionEnginePipeline("nothing matches", api);

    expect(execMock).not.toHaveBeenCalled();
  });

  it("does not call execute when match IPC fails", async () => {
    const execMock = vi.fn();
    const api: MockElectronAPI = {
      actionEngineMatch: vi.fn().mockRejectedValue(new Error("network error")),
      actionEngineExecute: execMock,
    };

    await runActionEnginePipeline("trigger", api);

    expect(execMock).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests: malformed IPC responses
// ─────────────────────────────────────────────────────────────────────────────

describe("action engine pipeline — malformed IPC responses", () => {
  it("handles null matchResult gracefully", async () => {
    const api: MockElectronAPI = {
      actionEngineMatch: vi.fn().mockResolvedValue(null),
    };

    const result = await runActionEnginePipeline("trigger", api);

    expect(result.actionHandled).toBe(false);
  });

  it("handles matchResult with non-array matches field", async () => {
    const api: MockElectronAPI = {
      // @ts-expect-error intentional malformed response
      actionEngineMatch: vi.fn().mockResolvedValue({ success: true, matches: "oops" }),
    };

    const result = await runActionEnginePipeline("trigger", api);

    expect(result.actionHandled).toBe(false);
  });

  it("handles undefined matchResult.matches", async () => {
    const api: MockElectronAPI = {
      actionEngineMatch: vi.fn().mockResolvedValue({ success: true }),
    };

    const result = await runActionEnginePipeline("trigger", api);

    expect(result.actionHandled).toBe(false);
  });
});
