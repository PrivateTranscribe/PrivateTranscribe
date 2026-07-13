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
const trayJs = readHelper("tray.js");
const appJsx = readSrc("App.jsx");
const settingsPage = readSrc("components/SettingsPage.tsx");
const useSettingsTs = readSrc("hooks/useSettings.ts");
const useWindowDrag = readSrc("hooks/useWindowDrag.js");
const toastTsx = readSrc("components/ui/Toast.tsx");
const preloadJs = fs.readFileSync(path.resolve(__dirname, "../../../preload.js"), "utf8");
const mainJs = fs.readFileSync(path.resolve(__dirname, "../../../main.js"), "utf8");

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

  test("taskbar snap stays inside workArea to avoid Windows shell z-order traps", () => {
    const idx = windowConfig.indexOf("getTaskbarSnappedPosition");
    expect(idx).toBeGreaterThan(-1);
    const block = windowConfig.slice(idx, idx + 2000);
    expect(block).toContain("inside the usable work area");
    expect(block).toContain("hidden permanently after Start/taskbar interactions");
    expect(block).toContain("clampButtonCenter(btnX, btnY, workArea)");
  });

  test("taskbar snap is on by default, with native starting from a safe off state", () => {
    // Native init stays false; the renderer pushes the real value on load.
    expect(windowManager).toContain("this.overlaySnapToTaskbar = false");
    expect(dragManager).toContain("this.snapToTaskbar = false");
    expect(dragManager).toContain("this.snapToTaskbar = enabled === true");
    // User-facing default is on: only an explicit "false" disables it.
    expect(appJsx).toContain('localStorage.getItem("overlaySnapToTaskbar") !== "false"');
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
    expect(dragManager).toContain("screen.getDisplayNearestPoint(proposedButtonPoint)");
  });

  test("drag loop ignores duplicate cursor samples to avoid stationary touchpad drift", () => {
    expect(dragManager).toContain("lastCursorPosition");
    expect(dragManager).toContain("cursorPos.x === this.lastCursorPosition.x");
    expect(dragManager).toContain("return;");
  });

  test("taskbar-snapped dragging locks to the display where the drag started", () => {
    expect(dragManager).toContain("this.dragDisplay = screen.getDisplayNearestPoint");
    expect(dragManager).toContain(
      "? this.dragDisplay || screen.getDisplayNearestPoint(proposedButtonPoint)"
    );
    expect(dragManager).toContain("this.dragDisplay = null");
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
    expect(windowManager).toContain("_refreshMainWindowInteractivity(`${reason}:${delay}`)");
    expect(windowManager).toContain(
      'this._refreshMainWindowInteractivity("display-metrics-changed")'
    );
  });

  test("main process notifies renderer to clear stale drag state after wake", () => {
    expect(windowManager).toContain("_resetOverlayDragState");
    expect(windowManager).toContain('webContents.send("window-drag-reset"');
    expect(preloadJs).toContain("onWindowDragReset");
    expect(useWindowDrag).toContain("onWindowDragReset");
  });

  test("Windows polls the mic hit area so glow remains click-through after wake", () => {
    expect(windowManager).not.toContain("setShape");
    expect(windowManager).toContain("_startHoverInteractivityProbe");
    expect(windowManager).toContain("_isCursorOverOverlayButton");
    expect(windowManager).toContain("transparent/glow area remains click-through");
    expect(windowManager).toContain("BUTTON_HIT_TEST_PADDING");
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

// ─── Sleep/wake drag and z-order hardening ─────────────────────────────────

describe("windowManager.js — sleep/wake overlay recovery", () => {
  test("power resume handler resets stuck drag state before reclamping", () => {
    // If sleep interrupted an active drag, isDragging stays true and
    // startWindowDrag() returns early ('drag already active'), leaving the
    // overlay unmovable. The resume handler must reset main and renderer drag state first.
    const idx = windowManager.indexOf("_powerResumeHandler = ()");
    expect(idx).toBeGreaterThan(-1);
    const block = windowManager.slice(idx, idx + 600);
    expect(block).toContain("_resetOverlayDragState");
    expect(block).toContain("_notifyOverlayRendererResumed");
    expect(block).toContain("_scheduleOverlayRecovery");
  });

  test("power resume and unlock notify renderer to restart mic visualization", () => {
    const resumeIdx = windowManager.indexOf("_powerResumeHandler = ()");
    const unlockIdx = windowManager.indexOf("_powerUnlockHandler = ()");
    expect(resumeIdx).toBeGreaterThan(-1);
    expect(unlockIdx).toBeGreaterThan(-1);

    const resumeBlock = windowManager.slice(resumeIdx, resumeIdx + 500);
    const unlockBlock = windowManager.slice(unlockIdx, unlockIdx + 500);

    expect(windowManager).toContain("_notifyOverlayRendererResumed(reason)");
    expect(windowManager).toContain('webContents.send("main-window-shown"');
    expect(resumeBlock).toContain('_notifyOverlayRendererResumed("resume")');
    expect(unlockBlock).toContain('_notifyOverlayRendererResumed("unlock-screen")');
  });

  test("wake recovery retries after display metrics have time to settle", () => {
    const idx = windowManager.indexOf("_scheduleOverlayRecovery");
    const block = windowManager.slice(idx, idx + 1200);
    expect(block).toContain("[2500, 6000]");
    expect(block).toContain("preferLastKnownButtonPosition: true");
    expect(block).toContain("persistPosition: false");
  });

  test("automatic display recovery does not persist transient monitor clamps", () => {
    expect(windowManager).toContain("this._lastKnownButtonPosition");
    expect(windowManager).toContain("_ignoreOverlayMoveSaveUntil");
    const idx = windowManager.indexOf('this._reclampOverlayPosition("display-metrics-changed"');
    expect(idx).toBeGreaterThan(-1);
    const block = windowManager.slice(idx, idx + 500);
    expect(block).toContain("preferLastKnownButtonPosition: true");
    expect(block).toContain("persistPosition: false");
  });

  test("unlock-screen also schedules overlay recovery", () => {
    expect(windowManager).toContain("_powerUnlockHandler = ()");
    expect(windowManager).toContain('powerMonitor.on("unlock-screen"');
    expect(windowManager).toContain('_scheduleOverlayRecovery("unlock-screen", [500, 2500, 6000])');
  });

  test("_reclampOverlayPosition always calls enforceMainWindowOnTop after repositioning", () => {
    // Find the method definition (not a call site) — it starts with two spaces indent
    const idx = windowManager.indexOf("  _reclampOverlayPosition(reason, options = {}) {");
    expect(idx).toBeGreaterThan(-1);
    const block = windowManager.slice(idx, idx + 3500);
    // enforceMainWindowOnTop must appear in the method body so z-order is
    // restored even when the position didn't need clamping.
    expect(block).toContain("enforceMainWindowOnTop");
  });

  test("dragManager exposes resetDragState to cleanly clear stuck isDragging flag", () => {
    expect(dragManager).toContain("resetDragState()");
    expect(dragManager).toContain("this.isDragging = false");
    expect(dragManager).toContain("stopMouseTracking()");
  });
});

describe("main.js / windowManager.js — startup overlay readiness", () => {
  test("startup delays initial overlay show so renderer IPC is ready", () => {
    expect(mainJs).toContain("initialShowDelayMs: 2000");
    expect(windowManager).toContain("initialShowDelayMs");
    expect(windowManager).toContain("setTimeout(showOverlay, initialShowDelayMs)");
  });

  test("renderer-ready IPC force-shows the overlay if ready-to-show left it hidden", () => {
    const idx = windowManager.indexOf("markMainWindowRendererReady()");
    expect(idx).toBeGreaterThan(-1);
    const block = windowManager.slice(idx, idx + 800);
    expect(block).toContain("must stay immediate");
    expect(block).toContain("Do not route this through the cosmetic startup delay");
    expect(block).toContain("!this.mainWindow.isVisible()");
    expect(block).toContain("!this.isOverlaySuppressed()");
    expect(block).toContain("showInactive");
    expect(block).not.toContain("setTimeout");
    expect(block).not.toContain("initialShowDelayMs");
  });
});

// ─── Overlay visibility state model — single source of truth ────────────────

describe("overlay state model — main process owns visibility", () => {
  test("windowManager defines the three-mode overlay state", () => {
    expect(windowManager).toContain('this.overlayMode = "shown"');
    expect(windowManager).toContain("setOverlayMode(mode, options = {})");
    expect(windowManager).toContain("snoozeOverlay(durationMs)");
    expect(windowManager).toContain("isOverlaySuppressed()");
  });

  test("snoozes are never persisted across restarts, shown/off are", () => {
    const idx = windowManager.indexOf("  _loadPersistedOverlayMode() {");
    expect(idx).toBeGreaterThan(-1);
    const block = windowManager.slice(idx, idx + 600);
    expect(block).toContain('parsed.mode === "shown" || parsed.mode === "off"');
    // The snoozed branch of setOverlayMode must not persist.
    const setIdx = windowManager.indexOf("setOverlayMode(mode, options = {})");
    const setBlock = windowManager.slice(setIdx, setIdx + 2500);
    const snoozeBranch = setBlock.slice(
      setBlock.indexOf('if (mode === "snoozed")'),
      setBlock.indexOf("} else {")
    );
    expect(snoozeBranch).not.toContain("_persistOverlayMode");
  });

  test("state changes are broadcast to all renderers", () => {
    expect(windowManager).toContain('webContents.send("overlay-state-changed", state)');
    expect(preloadJs).toContain("onOverlayStateChanged");
    expect(preloadJs).toContain('"overlay-state-changed"');
  });

  test("showDictationPanel refuses to show a snoozed or off overlay", () => {
    const idx = windowManager.indexOf("async showDictationPanel");
    expect(idx).toBeGreaterThan(-1);
    const block = windowManager.slice(idx, idx + 900);
    expect(block).toContain("this.isOverlaySuppressed()");
    expect(block).toContain("return null");
  });

  test("hotkey dictation does not force-show a suppressed overlay", () => {
    const idx = windowManager.indexOf("createHotkeyCallback()");
    expect(idx).toBeGreaterThan(-1);
    const block = windowManager.slice(idx, idx + 3000);
    expect(block).toContain("if (this.isOverlaySuppressed())");
    expect(block).toContain('send("toggle-dictation")');
  });

  test("renderers no longer push a localStorage overlayDisabled copy to main", () => {
    // The old push-sync could destroy a freshly re-shown overlay. Only the
    // one-time legacy migration may reference the localStorage key.
    expect(appJsx).not.toContain("setOverlayDisabled");
    expect(settingsPage).not.toContain("setOverlayDisabled(");
    expect(settingsPage).not.toContain('useLocalStorage("overlayDisabled"');
    expect(useSettingsTs).not.toContain('"overlayDisabled"');
    expect(appJsx).toContain("migrateLegacyOverlayDisabled");
    expect(appJsx).toContain('localStorage.removeItem("overlayDisabled")');
  });

  test("settings toggle mirrors main-process state via broadcast", () => {
    expect(settingsPage).toContain("getOverlayState");
    expect(settingsPage).toContain("onOverlayStateChanged");
    expect(settingsPage).toContain("setOverlayMode?.(mode)");
  });

  test("legacy migration never overrides a mode the main process persisted", () => {
    const idx = windowManager.indexOf("migrateLegacyOverlayDisabled(disabled)");
    expect(idx).toBeGreaterThan(-1);
    const block = windowManager.slice(idx, idx + 400);
    expect(block).toContain("hasPersistedOverlayMode()");
    expect(block).toContain("return false");
  });
});

describe("tray.js — menu layout and overlay toggle", () => {
  test("Open PrivateTranscribe is first, Exit is last", () => {
    const idx = trayJs.indexOf("buildContextMenuTemplate()");
    expect(idx).toBeGreaterThan(-1);
    const block = trayJs.slice(idx, idx + 2500);
    const openIdx = block.indexOf('"Open PrivateTranscribe"');
    const showIdx = block.indexOf('"Show overlay"');
    const exitIdx = block.indexOf('"Exit PrivateTranscribe"');
    expect(openIdx).toBeGreaterThan(-1);
    expect(showIdx).toBeGreaterThan(openIdx);
    expect(exitIdx).toBeGreaterThan(showIdx);
  });

  test("overlay toggle is a checkbox that routes through setOverlayMode", () => {
    expect(trayJs).toContain('type: "checkbox"');
    expect(trayJs).toContain('setOverlayMode("off")');
    expect(trayJs).toContain('setOverlayMode("shown")');
  });

  test("a snoozed overlay is surfaced in the tray menu", () => {
    expect(trayJs).toContain("Overlay hidden until");
  });
});

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
