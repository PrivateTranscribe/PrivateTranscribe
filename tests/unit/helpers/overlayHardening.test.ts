/**
 * Source-level invariant tests for overlay hardening edge cases.
 *
 * These tests read production source files as text and assert that key
 * behavioural invariants are present.  They run without Electron / JSDOM,
 * so no environment mocking is required.
 */
import { describe, expect, test } from "vitest";
import fs from "node:fs";
import path from "node:path";

function readHelper(name: string): string {
  return fs.readFileSync(path.resolve(__dirname, "../../../src/helpers", name), "utf8");
}

function readSrc(relPath: string): string {
  return fs.readFileSync(path.resolve(__dirname, "../../../src", relPath), "utf8");
}

const windowManager = readHelper("windowManager.js");
const windowConfig = readHelper("windowConfig.js");
const appJsx = readSrc("App.jsx");
const toastTsx = readSrc("components/ui/Toast.tsx");

// ─── Multi-monitor position clamping ─────────────────────────────────────────

describe("windowManager.js — multi-monitor position clamping", () => {
  test("saved position is clamped against the display nearest to the saved coords", () => {
    // Must use getDisplayNearestPoint to find the correct display when clamping a
    // saved overlay position, otherwise secondary-monitor positions get snapped to
    // the primary display bounds on next launch.
    expect(windowManager).toContain("getDisplayNearestPoint");
  });

  test("clamping uses the saved position as the nearest-point query", () => {
    // The nearest-point lookup must reference the saved x/y, not a hardcoded point.
    // Multiple getDisplayNearestPoint calls exist; verify the saved-position one is present.
    expect(windowManager).toContain("getDisplayNearestPoint({ x: saved.x, y: saved.y })");
  });

  test("primary display lookup is still used as fallback when no saved position", () => {
    // The initial default position still anchors to the primary display.
    expect(windowManager).toContain("getPrimaryDisplay");
  });

  test("resizeMainWindow clamps X and Y to prevent off-screen drift", () => {
    // resizeMainWindow must call Math.max and Math.min to clamp both axes.
    const idx = windowManager.indexOf("resizeMainWindow");
    expect(idx).toBeGreaterThan(-1);
    const block = windowManager.slice(idx, idx + 3200);
    expect(block).toContain("Math.max");
    expect(block).toContain("Math.min");
    expect(block).toContain("workArea.x");
  });

  test("toast expansion preserves the original base X anchor for collapse/edge flips", () => {
    // The overlay should remember its base-size X position before temporary
    // expansions so right-edge toast/menu flips don't leave the mic shifted.
    const idx = windowManager.indexOf("resizeMainWindow");
    expect(idx).toBeGreaterThan(-1);
    const block = windowManager.slice(idx, idx + 2800);
    expect(block).toContain("this._originalBaseX");
    expect(block).toContain("_originalBaseBottomY");
    expect(block).toContain("WINDOW_SIZES.BASE.width");
  });
});

// ─── Toast positioning — adaptive side placement in tiny overlay ────────────

describe("Toast.tsx — adaptive toast placement for dictation overlay", () => {
  test("dictation overlay computes toastOnLeft from screen edge proximity", () => {
    expect(toastTsx).toContain("const toastOnLeft =");
    expect(toastTsx).toContain("window.screenX + 380 > window.screen.width");
  });

  test("dictation overlay supports both left and right toast placements", () => {
    expect(toastTsx).toContain("bottom-20 left-6 items-start");
    expect(toastTsx).toContain("bottom-20 right-6 items-end");
  });
});

// ─── Escape key handling during recording ────────────────────────────────────

describe("App.jsx — Escape key during recording/processing", () => {
  test("Escape cancels recording when isRecording is true", () => {
    // The Escape handler must call cancelRecording() when isRecording is set.
    // Use a larger slice since the handler body spans several hundred characters.
    const escIdx = appJsx.indexOf('"Escape"');
    expect(escIdx).toBeGreaterThan(-1);
    const block = appJsx.slice(escIdx, escIdx + 700);
    expect(block).toContain("isRecording");
    expect(block).toContain("cancelRecording");
  });

  test("Escape cancels processing when isProcessing is true", () => {
    const escIdx = appJsx.indexOf('"Escape"');
    const block = appJsx.slice(escIdx, escIdx + 700);
    expect(block).toContain("isProcessing");
    expect(block).toContain("cancelProcessing");
  });

  test("Escape does not hide overlay when recording is active", () => {
    // hideWindow must not appear BEFORE the isRecording/isProcessing guard in the
    // Escape branch — i.e. hideWindow is only called in the idle else branch.
    const escIdx = appJsx.indexOf('"Escape"');
    const block = appJsx.slice(escIdx, escIdx + 700);
    const hideIdx = block.indexOf("hideWindow");
    const recordingIdx = block.indexOf("isRecording");
    // hideWindow must come after the recording guard (higher offset in the block)
    expect(recordingIdx).toBeGreaterThan(-1);
    expect(hideIdx).toBeGreaterThan(recordingIdx);
  });

  test("keydown handler depends on isRecording and isProcessing for fresh state", () => {
    // The dep array of the keydown useEffect must include isRecording and isProcessing
    // so the handler always captures the current values.
    const idx = appJsx.indexOf('document.addEventListener("keydown"');
    expect(idx).toBeGreaterThan(-1);
    // The dep array follows the event listener removal in the return cleanup
    const block = appJsx.slice(idx, idx + 400);
    expect(block).toContain("isRecording");
    expect(block).toContain("isProcessing");
  });
});

// ─── Language submenu overflow prevention ────────────────────────────────────

describe("App.jsx — quickLanguages capped to prevent submenu overflow", () => {
  test("quickLanguages is sliced to at most 7 entries", () => {
    // Without a cap, a non-preferred selected language adds an 8th entry, making
    // the language submenu taller than the WITH_MENU window allows.
    expect(appJsx).toContain(".slice(0, 7)");
  });

  test("cap is applied after deduplication", () => {
    // The order must be: Set dedup → slice, not slice → Set.
    const idx = appJsx.indexOf(".slice(0, 7)");
    expect(idx).toBeGreaterThan(-1);
    const beforeSlice = appJsx.slice(0, idx);
    // new Set must appear before .slice in the quickLanguages memo
    const setIdx = beforeSlice.lastIndexOf("new Set(");
    expect(setIdx).toBeGreaterThan(-1);
  });
});

// ─── Window size constants — sanity checks ───────────────────────────────────

describe("windowConfig.js — window size constants", () => {
  test("WITH_TOAST width is narrower than EXPANDED to minimise right-edge shift", () => {
    // Extract numeric widths from WINDOW_SIZES declaration
    const withToastMatch = windowConfig.match(/WITH_TOAST:\s*\{\s*width:\s*(\d+)/);
    const expandedMatch = windowConfig.match(/EXPANDED:\s*\{\s*width:\s*(\d+)/);
    expect(withToastMatch).not.toBeNull();
    expect(expandedMatch).not.toBeNull();
    const withToastWidth = parseInt(withToastMatch![1], 10);
    const expandedWidth = parseInt(expandedMatch![1], 10);
    expect(withToastWidth).toBeLessThan(expandedWidth);
  });

  test("WITH_MENU height leaves room for context menu content", () => {
    // WITH_MENU must be tall enough to show the root submenu (≈240px content +
    // button clearance ≈80px = ≈320px minimum).
    const match = windowConfig.match(/WITH_MENU:\s*\{\s*width:\s*\d+,\s*height:\s*(\d+)/);
    expect(match).not.toBeNull();
    const height = parseInt(match![1], 10);
    expect(height).toBeGreaterThanOrEqual(320);
  });
});
