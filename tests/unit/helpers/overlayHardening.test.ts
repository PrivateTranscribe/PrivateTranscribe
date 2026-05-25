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
const dragManager = readHelper("dragManager.js");
const appJsx = readSrc("App.jsx");
const useWindowDrag = readSrc("hooks/useWindowDrag.js");
const toastTsx = readSrc("components/ui/Toast.tsx");

// ─── Multi-monitor position clamping ─────────────────────────────────────────

describe("windowManager.js — multi-monitor position clamping", () => {
  test("saved position is clamped against the display nearest to the saved coords", () => {
    // Must use getDisplayNearestPoint to find the correct display when clamping a
    // saved overlay position, otherwise secondary-monitor positions get snapped to
    // the primary display bounds on next launch.
    expect(windowManager).toContain("getDisplayNearestPoint");
  });

  test("clamping uses the saved button position as the nearest-point query", () => {
    // The nearest-point lookup must reference the restored saved position, not a hardcoded point.
    // The implementation now normalizes saved button coords into btnX / btnY before querying.
    expect(windowManager).toContain("const btnX = saved.x");
    expect(windowManager).toContain("const btnY = saved.y");
    expect(windowManager).toContain("getDisplayNearestPoint({ x: btnX, y: btnY })");
  });

  test("primary display lookup is still used as fallback when no saved position", () => {
    // The initial default position still anchors to the primary display.
    expect(windowManager).toContain("getPrimaryDisplay");
  });

  test("re-clamping uses shared overlay constraint logic against the active display", () => {
    const idx = windowManager.indexOf("_reclampOverlayPosition");
    expect(idx).toBeGreaterThan(-1);
    const block = windowManager.slice(idx, idx + 5000);
    expect(block).toContain("this._constrainOverlayPosition");
    expect(block).toContain("display.workArea || display.bounds");
    expect(block).toContain("this.mainWindow.setBounds");
  });

  test("overlay constraint falls back to clampPosition when taskbar snap is disabled", () => {
    const idx = windowManager.indexOf("_constrainOverlayPosition");
    expect(idx).toBeGreaterThan(-1);
    const block = windowManager.slice(idx, idx + 1000);
    expect(block).toContain("this.overlaySnapToTaskbar");
    expect(block).toContain("WindowPositionUtil.getTaskbarSnappedPosition");
    expect(block).toContain("WindowPositionUtil.clampPosition");
  });

  test("saved/restored overlay math still anchors to button offsets", () => {
    // The fixed transparent container keeps the button as the durable anchor.
    expect(windowManager).toContain("BUTTON_OFFSET_X");
    expect(windowManager).toContain("BUTTON_OFFSET_Y");
    expect(windowManager).toContain("winX = btnX - BUTTON_OFFSET_X");
    expect(windowManager).toContain("winY = btnY - BUTTON_OFFSET_Y");
  });
});

// ─── Drag handling — touchpad release and work-area bounds ──────────────────

describe("dragManager.js / useWindowDrag.js — robust overlay dragging", () => {
  test("dragging reuses shared WindowPositionUtil.clampPosition", () => {
    expect(dragManager).toContain("WindowPositionUtil.clampPosition");
    expect(dragManager).toContain("display.workArea || display.bounds");
  });

  test("drag clamping uses proposed button position for display selection", () => {
    expect(dragManager).toContain("proposedButtonPoint");
    expect(dragManager).toContain("getDisplayNearestPoint(proposedButtonPoint)");
  });

  test("drag stop listens beyond document mouseup for touchpad/outside-window releases", () => {
    expect(useWindowDrag).toContain('window.addEventListener("mouseup"');
    expect(useWindowDrag).toContain('window.addEventListener("pointerup"');
    expect(useWindowDrag).toContain('window.addEventListener("pointercancel"');
    expect(useWindowDrag).toContain('window.addEventListener("blur"');
  });

  test("main process refreshes overlay mouse forwarding after display wake changes", () => {
    expect(windowManager).toContain("_refreshMainWindowInteractivity");
    expect(windowManager).toContain("setIgnoreMouseEvents(false)");
    expect(windowManager).toContain("this.setMainWindowInteractivity(shouldCapture)");
    expect(windowManager).toContain('this._refreshMainWindowInteractivity("resume")');
    expect(windowManager).toContain(
      'this._refreshMainWindowInteractivity("display-metrics-changed")'
    );
  });

  test("renderer requests interactivity refresh when Chromium becomes active again", () => {
    expect(appJsx).toContain("refreshMainWindowInteractivity");
    expect(appJsx).toContain('document.addEventListener("visibilitychange"');
    expect(appJsx).toContain('window.addEventListener("pageshow"');
    expect(appJsx).toContain('window.addEventListener("focus"');
  });
});

// ─── Toast positioning — adaptive side placement in tiny overlay ────────────

describe("Toast.tsx — adaptive toast placement for dictation overlay", () => {
  test("dictation overlay computes toastOnLeft from screen edge proximity", () => {
    expect(toastTsx).toContain("const toastOnLeft =");
    expect(toastTsx).toContain("window.screenX + 380 > window.screen.width");
  });

  test("dictation overlay supports both left and right toast placements", () => {
    expect(toastTsx).toContain("bottom-[110px] left-6 items-start");
    expect(toastTsx).toContain("bottom-[110px] right-6 items-end");
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
    const block = appJsx.slice(escIdx, escIdx + 900);
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
  test("WITH_TOAST width is narrower than the fixed transparent container", () => {
    const withToastMatch = windowConfig.match(/WITH_TOAST:\s*\{\s*width:\s*(\d+)/);
    const containerMatch = windowConfig.match(/const CONTAINER_W = (\d+);/);
    expect(withToastMatch).not.toBeNull();
    expect(containerMatch).not.toBeNull();
    const withToastWidth = parseInt(withToastMatch![1], 10);
    const containerWidth = parseInt(containerMatch![1], 10);
    expect(withToastWidth).toBeLessThan(containerWidth);
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
