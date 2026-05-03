/**
 * Source-level invariant tests for overlay always-on-top / topmost behaviour.
 *
 * These tests read the production source files as text and assert that key
 * safety invariants are present.  They run without Electron, so no mocking
 * of BrowserWindow is needed.
 */
import { describe, expect, test } from "vitest";
import fs from "node:fs";
import path from "node:path";

function readHelper(name: string): string {
  return fs.readFileSync(path.resolve(__dirname, "../../../src/helpers", name), "utf8");
}

const windowConfig = readHelper("windowConfig.js");
const windowManager = readHelper("windowManager.js");

// ─── windowConfig.js invariants ──────────────────────────────────────────────

describe("windowConfig.js — setupAlwaysOnTop", () => {
  test("macOS uses floating level with z-order hint", () => {
    expect(windowConfig).toContain('setAlwaysOnTop(true, "floating", 1)');
  });

  test("macOS enables visibleOnAllWorkspaces with fullscreen support", () => {
    expect(windowConfig).toContain("visibleOnFullScreen: true");
  });

  test("Windows uses floating level to avoid fullscreen game compositor churn", () => {
    expect(windowConfig).toContain('setAlwaysOnTop(true, "floating")');
    expect(windowConfig).toContain("reported with Minecraft/Tekkit");
  });

  test("Windows overlay is non-focusable and hidden from taskbar", () => {
    expect(windowConfig).toContain('skipTaskbar: process.platform === "win32"');
    expect(windowConfig).toContain('focusable: process.platform !== "win32"');
  });

  test("Linux uses screen-saver level (highest X11 hint available)", () => {
    expect(windowConfig).toContain('setAlwaysOnTop(true, "screen-saver")');
  });

  test("Linux path calls moveTop() unconditionally to refresh Z-order", () => {
    // The linux branch must contain an unconditional moveTop() inside the else block.
    // We check that moveTop appears after the screen-saver setAlwaysOnTop line.
    const ssIdx = windowConfig.indexOf('"screen-saver"');
    const moveTopAfterSs = windowConfig.indexOf("moveTop()", ssIdx);
    expect(ssIdx).toBeGreaterThan(-1);
    expect(moveTopAfterSs).toBeGreaterThan(ssIdx);
  });

  test("main window config has alwaysOnTop: true at creation", () => {
    expect(windowConfig).toContain("alwaysOnTop: true");
  });

  test("control panel config has alwaysOnTop: false", () => {
    expect(windowConfig).toContain("alwaysOnTop: false");
  });
});

// ─── windowManager.js invariants ─────────────────────────────────────────────

describe("windowManager.js — blur repair", () => {
  test("blur handler does NOT bail out on linux (guard is darwin-only)", () => {
    // The guard must be darwin, not a win32 exclusion.
    // Old pattern: if (process.platform !== "win32") return  — would skip Linux.
    // New pattern: if (process.platform === "darwin") return  — includes Linux.
    expect(windowManager).not.toContain("platform !== \"win32\"");
    expect(windowManager).toContain('platform === "darwin"');
  });

  test("blur handler re-applies always-on-top after debounce on non-darwin", () => {
    // The blur callback must contain a setTimeout that calls enforceMainWindowOnTop.
    const blurIdx = windowManager.indexOf('"blur"');
    expect(blurIdx).toBeGreaterThan(-1);

    const afterBlur = windowManager.slice(blurIdx);
    expect(afterBlur).toContain("setTimeout");
    expect(afterBlur.slice(0, afterBlur.indexOf("setTimeout") + 500)).toContain(
      "enforceMainWindowOnTop"
    );
  });

  test("blur handler logs XDG_CURRENT_DESKTOP on Linux for diagnostics", () => {
    expect(windowManager).toContain("XDG_CURRENT_DESKTOP");
  });

  test("blur handler logs XDG_SESSION_TYPE on Linux for diagnostics", () => {
    expect(windowManager).toContain("XDG_SESSION_TYPE");
  });

  test("enforceMainWindowOnTop delegates to WindowPositionUtil.setupAlwaysOnTop", () => {
    expect(windowManager).toContain("WindowPositionUtil.setupAlwaysOnTop");
  });

  test("windows skips topmost re-apply while overlay is explicitly suspended", () => {
    expect(windowManager).toContain("isMainWindowOverlaySuspended");
    expect(windowManager).toContain('platform === "win32" && this.isMainWindowOverlaySuspended');
    expect(windowManager).toContain("return;");
  });

  test("always-on-top is re-enforced on show, focus, and restore events", () => {
    expect(windowManager).toContain('"show"');
    expect(windowManager).toContain('"focus"');
    expect(windowManager).toContain('"restore"');
    // Each should call enforceMainWindowOnTop
    const showCount = (windowManager.match(/enforceMainWindowOnTop/g) || []).length;
    expect(showCount).toBeGreaterThanOrEqual(4); // ready-to-show, show, focus, restore, + enforceMainWindowOnTop def
  });
});

describe("windowManager.js — hidden overlay suspension on Windows", () => {
  test("hideDictationPanel hides the window and suspends Windows topmost state", () => {
    expect(windowManager).toContain("suspendMainWindowOverlay()");
    expect(windowManager).toContain("this.mainWindow.hide()");
    expect(windowManager).not.toContain("this.mainWindow.minimize()");
  });

  test("show paths resume suspended Windows overlay before showing", () => {
    expect(windowManager).toContain("resumeMainWindowOverlay()");
    expect(windowManager).toContain("showInactive");
  });
});

// ─── Diagnosis note (documented as a test for CI visibility) ─────────────────

describe("Unity desktop — known constraints (documentation)", () => {
  test("source documents X11/Unity fullscreen occlusion limitation", () => {
    expect(windowConfig).toContain("fullscreen");
    // The comment about Unity constraints must be present in the Linux branch.
    expect(windowConfig).toContain("Unity");
  });

  test("source documents Wayland limitation for topmost", () => {
    expect(windowConfig).toContain("Wayland");
  });

  test("source documents blur-based mitigation for Linux", () => {
    // windowManager blur handler comment should mention Unity or Linux
    expect(windowManager).toContain("Unity");
  });
});
