/**
 * Unit tests for the ActionEngineManager transcript debounce guard.
 *
 * We construct a minimal ActionEngineManager with a fake DB + action so that
 * the debounce logic can be exercised without Electron or real SQLite.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Minimal mocks ──────────────────────────────────────────────────────────

vi.mock("electron", () => ({
  shell: { openPath: vi.fn(), openExternal: vi.fn() },
}));

// We use a dynamic require after mocking electron so the module can load.
async function loadManager() {
  const mod = await import("../../../src/helpers/actionEngineManager.js");
  return mod;
}

function makeFakeAction(id = "action-1") {
  return {
    id,
    name: "Test Action",
    enabled: true,
    trigger: "hello world",
    triggerMode: "contains",
    triggerCaseSensitive: false,
    triggerRegex: false,
    type: "dictation-mode",
    payload: { mode: "dictation" },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function makeFakeDb(action: ReturnType<typeof makeFakeAction>) {
  const runs: unknown[] = [];
  return {
    prepare: vi.fn((sql: string) => ({
      get: vi.fn((_id: string) => (sql.includes("actions") ? action : null)),
      all: vi.fn(() => []),
      run: vi.fn((...args: unknown[]) => {
        if (sql.includes("action_runs")) runs.push(args);
        return { changes: 1 };
      }),
    })),
    _runs: runs,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("ActionEngineManager — transcript debounce", () => {
  const ACTION_ID = "action-abc";

  beforeEach(() => {
    delete process.env.PRIVOCA_ACTION_DEBOUNCE_MS;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.resetModules();
  });

  it("applies a 2 s default debounce window for transcript-triggered runs", async () => {
    const { ActionEngineManager } = await loadManager() as { ActionEngineManager: any };
    const action = makeFakeAction(ACTION_ID);
    const db = makeFakeDb(action);
    const mgr = new ActionEngineManager({ db });

    // Stub executeAction path — we only care about debounce, not execution result
    // The manager calls executeAction internally; override via spying on db.prepare
    // to return the action and treat run insert as a no-op.

    const first = await mgr.executeById(ACTION_ID, {}, { triggeredBy: "transcript" });
    // First call should not be debounced (no prior run)
    expect(first.debounced).toBeFalsy();

    // Immediately second call — should be debounced
    const second = await mgr.executeById(ACTION_ID, {}, { triggeredBy: "transcript" });
    expect(second.debounced).toBe(true);
    expect(second.success).toBe(false);
    expect(second.error).toMatch(/debounced/i);
  });

  it("allows re-execution after the cooldown has elapsed", async () => {
    const { ActionEngineManager } = await loadManager() as { ActionEngineManager: any };
    const action = makeFakeAction(ACTION_ID);
    const db = makeFakeDb(action);
    const mgr = new ActionEngineManager({ db });

    await mgr.executeById(ACTION_ID, {}, { triggeredBy: "transcript" });

    // Advance time past the 2 s cooldown
    vi.advanceTimersByTime(2001);

    const third = await mgr.executeById(ACTION_ID, {}, { triggeredBy: "transcript" });
    expect(third.debounced).toBeFalsy();
  });

  it("never debounces manual (Test button) runs", async () => {
    const { ActionEngineManager } = await loadManager() as { ActionEngineManager: any };
    const action = makeFakeAction(ACTION_ID);
    const db = makeFakeDb(action);
    const mgr = new ActionEngineManager({ db });

    // Mark a transcript run as having just happened
    await mgr.executeById(ACTION_ID, {}, { triggeredBy: "transcript" });

    // Manual run immediately after should still execute
    const manual = await mgr.executeById(ACTION_ID, {}, { triggeredBy: "manual" });
    expect(manual.debounced).toBeFalsy();
  });

  it("debounce window is independent per action id", async () => {
    const { ActionEngineManager } = await loadManager() as { ActionEngineManager: any };
    const actionA = makeFakeAction("action-A");
    const actionB = makeFakeAction("action-B");

    // DB returns action based on id
    const db = {
      prepare: vi.fn((sql: string) => ({
        get: vi.fn((id: string) => {
          if (id === "action-A") return actionA;
          if (id === "action-B") return actionB;
          return null;
        }),
        all: vi.fn(() => []),
        run: vi.fn(() => ({ changes: 1 })),
      })),
    };
    const mgr = new ActionEngineManager({ db });

    await mgr.executeById("action-A", {}, { triggeredBy: "transcript" });

    // action-B should still be free even if action-A is cooling down
    const bResult = await mgr.executeById("action-B", {}, { triggeredBy: "transcript" });
    expect(bResult.debounced).toBeFalsy();

    // action-A is still in cooldown
    const aAgain = await mgr.executeById("action-A", {}, { triggeredBy: "transcript" });
    expect(aAgain.debounced).toBe(true);
  });

  it("respects PRIVOCA_ACTION_DEBOUNCE_MS env override (0 = disabled)", async () => {
    process.env.PRIVOCA_ACTION_DEBOUNCE_MS = "0";
    const { ActionEngineManager } = await loadManager() as { ActionEngineManager: any };
    const action = makeFakeAction(ACTION_ID);
    const db = makeFakeDb(action);
    const mgr = new ActionEngineManager({ db });

    await mgr.executeById(ACTION_ID, {}, { triggeredBy: "transcript" });

    // With debounce disabled, same action should fire again immediately
    const second = await mgr.executeById(ACTION_ID, {}, { triggeredBy: "transcript" });
    expect(second.debounced).toBeFalsy();
  });
});
