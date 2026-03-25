/**
 * Unit tests for contextPipeline — the shared Smart Context helper.
 *
 * Pure functions (buildWhisperContextHint) are tested without any mocking.
 * getContext / isSmartContextEnabled tests manipulate globalThis.window and
 * module mocks to stay isolated from Electron and the Pro-entitlement check.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─────────────────────────────────────────────────────────────────────────────
// Mock useProStatus so getEffectiveEntitlement is controllable in every test.
// ─────────────────────────────────────────────────────────────────────────────
vi.mock("../../../src/hooks/useProStatus", () => ({
  getEffectiveEntitlement: vi.fn(() => "pro"),
}));

import { getEffectiveEntitlement } from "../../../src/hooks/useProStatus";

// Import after mocks are set up
import {
  buildWhisperContextHint,
  getContext,
  isSmartContextEnabled,
} from "../../../src/helpers/contextPipeline";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeWindow(overrides: Record<string, unknown> = {}): typeof window {
  return {
    electronAPI: {
      getActiveWindowContext: vi.fn(),
    },
    localStorage: {
      getItem: vi.fn(() => null),
    },
    ...overrides,
  } as unknown as typeof window;
}

// ─────────────────────────────────────────────────────────────────────────────
// buildWhisperContextHint — pure function, no mocking needed
// ─────────────────────────────────────────────────────────────────────────────

describe("buildWhisperContextHint", () => {
  it("returns null for null input", () => {
    expect(buildWhisperContextHint(null)).toBeNull();
  });

  it("returns null for undefined input", () => {
    expect(buildWhisperContextHint(undefined)).toBeNull();
  });

  it("returns null when available is false", () => {
    expect(buildWhisperContextHint({ available: false, source: "timeout" })).toBeNull();
  });

  it("returns null when available is true but no useful fields", () => {
    expect(buildWhisperContextHint({ available: true, source: "ipc" })).toBeNull();
  });

  it("includes appName only", () => {
    const hint = buildWhisperContextHint({ available: true, source: "ipc", appName: "Chrome" });
    expect(hint).toBe("App: Chrome");
  });

  it("includes windowTitle only", () => {
    const hint = buildWhisperContextHint({
      available: true,
      source: "ipc",
      windowTitle: "GitHub – Pull Requests",
    });
    expect(hint).toBe("Window: GitHub – Pull Requests");
  });

  it("includes both appName and windowTitle", () => {
    const hint = buildWhisperContextHint({
      available: true,
      source: "ipc",
      appName: "VS Code",
      windowTitle: "main.ts — my-project",
    });
    expect(hint).toBe("App: VS Code, Window: main.ts — my-project");
  });

  it("falls back to processName when appName is absent", () => {
    const hint = buildWhisperContextHint({
      available: true,
      source: "ipc",
      processName: "code.exe",
    });
    expect(hint).toBe("App: code.exe");
  });

  it("falls back to appClass when appName and processName are absent", () => {
    const hint = buildWhisperContextHint({ available: true, source: "ipc", appClass: "firefox" });
    expect(hint).toBe("App: firefox");
  });

  it("truncates long window titles to 80 chars with ellipsis", () => {
    const longTitle = "A".repeat(100);
    const hint = buildWhisperContextHint({ available: true, source: "ipc", windowTitle: longTitle });
    expect(hint).not.toBeNull();
    expect(hint!.length).toBeLessThanOrEqual("Window: ".length + 80);
    expect(hint).toContain("...");
  });

  it("does NOT include uiaText (too verbose for Whisper)", () => {
    const hint = buildWhisperContextHint({
      available: true,
      source: "ipc",
      appName: "Notepad",
      uiaText: "This is sensitive focused element text",
    });
    expect(hint).not.toContain("uia");
    expect(hint).not.toContain("focused element text");
    expect(hint).not.toContain("sensitive");
    expect(hint).toBe("App: Notepad");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getContext
// ─────────────────────────────────────────────────────────────────────────────

describe("getContext", () => {
  let originalWindow: typeof globalThis.window;

  beforeEach(() => {
    originalWindow = globalThis.window;
  });

  afterEach(() => {
    globalThis.window = originalWindow;
  });

  it("returns unavailable when electronAPI is absent", async () => {
    globalThis.window = makeWindow({ electronAPI: undefined });
    const result = await getContext();
    expect(result.available).toBe(false);
    expect(result.source).toBe("unavailable");
  });

  it("returns unavailable when getActiveWindowContext is not a function", async () => {
    globalThis.window = makeWindow({
      electronAPI: { getActiveWindowContext: "not-a-function" },
    });
    const result = await getContext();
    expect(result.available).toBe(false);
    expect(result.source).toBe("unavailable");
  });

  it("returns unavailable with reason when IPC resolves to null", async () => {
    globalThis.window = makeWindow({
      electronAPI: { getActiveWindowContext: vi.fn().mockResolvedValue(null) },
    });
    const result = await getContext();
    expect(result.available).toBe(false);
    expect(result.source).toBe("unavailable");
  });

  it("returns ipc result with source:'ipc' on success", async () => {
    const ipcResult = {
      available: true,
      platform: "linux" as const,
      appClass: "firefox",
      windowTitle: "GitHub",
    };
    globalThis.window = makeWindow({
      electronAPI: { getActiveWindowContext: vi.fn().mockResolvedValue(ipcResult) },
    });

    const result = await getContext();
    expect(result.available).toBe(true);
    expect(result.source).toBe("ipc");
    expect(result.appClass).toBe("firefox");
    expect(result.windowTitle).toBe("GitHub");
  });

  it("returns timeout result when IPC takes longer than timeoutMs", async () => {
    vi.useFakeTimers();

    const neverResolves = new Promise(() => {/* intentionally never settles */});
    globalThis.window = makeWindow({
      electronAPI: { getActiveWindowContext: vi.fn().mockReturnValue(neverResolves) },
    });

    const resultPromise = getContext({ timeoutMs: 100 });
    vi.advanceTimersByTime(200);
    const result = await resultPromise;

    expect(result.available).toBe(false);
    expect(result.source).toBe("timeout");

    vi.useRealTimers();
  });

  it("returns error result when IPC throws", async () => {
    globalThis.window = makeWindow({
      electronAPI: {
        getActiveWindowContext: vi.fn().mockRejectedValue(new Error("IPC channel closed")),
      },
    });

    const result = await getContext();
    expect(result.available).toBe(false);
    expect(result.source).toBe("error");
    expect(result.reason).toContain("IPC channel closed");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// isSmartContextEnabled
// ─────────────────────────────────────────────────────────────────────────────

describe("isSmartContextEnabled", () => {
  let originalWindow: typeof globalThis.window;
  const mockGetEntitlement = getEffectiveEntitlement as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    originalWindow = globalThis.window;
    mockGetEntitlement.mockReturnValue("pro");
  });

  afterEach(() => {
    globalThis.window = originalWindow;
  });

  it("returns false when window is undefined", () => {
    // @ts-expect-error intentional
    globalThis.window = undefined;
    expect(isSmartContextEnabled()).toBe(false);
  });

  it("returns false when entitlement is not pro", () => {
    mockGetEntitlement.mockReturnValue("free");
    globalThis.window = makeWindow({
      localStorage: { getItem: vi.fn().mockReturnValue("true") },
    });
    expect(isSmartContextEnabled()).toBe(false);
  });

  it("returns true when entitlement is pro and enableContextCapture is 'true'", () => {
    globalThis.window = makeWindow({
      localStorage: {
        getItem: vi.fn((key: string) => (key === "enableContextCapture" ? "true" : null)),
      },
    });
    expect(isSmartContextEnabled()).toBe(true);
  });

  it("returns false when enableContextCapture is 'false' even with pro entitlement", () => {
    globalThis.window = makeWindow({
      localStorage: {
        getItem: vi.fn((key: string) => (key === "enableContextCapture" ? "false" : null)),
      },
    });
    expect(isSmartContextEnabled()).toBe(false);
  });

  it("falls back to legacy includeActiveWindowContextInReasoning key", () => {
    globalThis.window = makeWindow({
      localStorage: {
        getItem: vi.fn((key: string) => {
          if (key === "includeActiveWindowContextInReasoning") return "true";
          return null;
        }),
      },
    });
    expect(isSmartContextEnabled()).toBe(true);
  });

  it("returns false when neither key is set", () => {
    globalThis.window = makeWindow({
      localStorage: { getItem: vi.fn().mockReturnValue(null) },
    });
    expect(isSmartContextEnabled()).toBe(false);
  });
});
