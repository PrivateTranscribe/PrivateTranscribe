import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const WindowManager = require("../../../src/helpers/windowManager");

/**
 * On Windows, `setIgnoreMouseEvents(true, { forward: true })` is backed by a
 * global low-level mouse hook: every mouse event on the desktop passes through
 * it. Re-arming the overlay's interactivity toggles that hook down and back up.
 *
 * A single display wake fires powerMonitor "resume", "unlock-screen", a
 * debounced display-metrics change, and three renderer-side events
 * (visibilitychange, pageshow, focus). Each used to re-arm, so one wake cycled a
 * system-wide input hook six or more times. The main process crashed with
 * 0xC000041D — a fatal exception inside a win32k user callback — after 53 hours
 * and 16 display transitions, with system-wide mouse lag reported just before.
 *
 * These lock in the two properties that reduce that churn without losing the
 * stale-hover fix the refresh exists for.
 */

type FakeWindow = {
  isDestroyed: () => boolean;
  isVisible: () => boolean;
  setIgnoreMouseEvents: ReturnType<typeof vi.fn>;
};

function buildManager({ visible = true, overlayMode = "shown" } = {}) {
  // Construct without running the real constructor: it touches Electron's app,
  // screen and powerMonitor singletons, which do not exist under vitest.
  const manager = Object.create(WindowManager.prototype);

  const setIgnoreMouseEvents = vi.fn();
  const mainWindow: FakeWindow = {
    isDestroyed: () => false,
    isVisible: () => visible,
    setIgnoreMouseEvents,
  };

  manager.mainWindow = mainWindow;
  manager.overlayMode = overlayMode;
  manager.isMainWindowInteractive = false;
  manager._overlayMouseCaptured = false;
  manager._interactivityRefreshTimer = null;
  manager._deferredInteractivityRefreshTimer = null;
  manager._lastInteractivityRefreshAt = 0;
  manager._overlayRecoveryTimers = new Set();

  return { manager, setIgnoreMouseEvents };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-30T01:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("overlay interactivity re-arm", () => {
  it("re-arms once for a wake cluster instead of once per event", () => {
    const { manager, setIgnoreMouseEvents } = buildManager();

    // A wake does not deliver its events in one tick — they arrive spread over
    // a couple of seconds, which is exactly the shape that used to produce a
    // full hook cycle per event. Timings mirror a real wake: powerMonitor
    // resume, then unlock-screen, then the 2s-debounced display-metrics change,
    // then the renderer's visibilitychange reaction.
    manager._refreshMainWindowInteractivity("resume");
    vi.advanceTimersByTime(800);
    manager._refreshMainWindowInteractivity("unlock-screen");
    vi.advanceTimersByTime(1200);
    manager._refreshMainWindowInteractivity("display-metrics-changed");
    vi.advanceTimersByTime(500);
    manager._refreshMainWindowInteractivity("renderer");
    vi.advanceTimersByTime(200);

    // One cycle: capture on, then back off 150ms later. Before coalescing, each
    // of those four events ran its own cycle — eight calls by this point, i.e.
    // a system-wide input hook taken down and rebuilt four times for one wake.
    expect(setIgnoreMouseEvents).toHaveBeenCalledTimes(2);
  });

  it("still runs the last request of a burst, so a settled display is not missed", () => {
    const { manager, setIgnoreMouseEvents } = buildManager();

    manager._refreshMainWindowInteractivity("renderer");
    vi.advanceTimersByTime(150);
    expect(setIgnoreMouseEvents).toHaveBeenCalledTimes(2);

    // Arrives inside the cooldown — deferred, not dropped.
    manager._refreshMainWindowInteractivity("display-metrics-changed");
    vi.advanceTimersByTime(150);
    expect(setIgnoreMouseEvents).toHaveBeenCalledTimes(2);

    // ...and lands once the cooldown expires.
    vi.advanceTimersByTime(3000);
    vi.advanceTimersByTime(150);
    expect(setIgnoreMouseEvents).toHaveBeenCalledTimes(4);
  });

  it("never touches the hook while the overlay is switched off", () => {
    const { manager, setIgnoreMouseEvents } = buildManager({ overlayMode: "off" });

    manager._refreshMainWindowInteractivity("resume");
    vi.advanceTimersByTime(5000);

    expect(setIgnoreMouseEvents).not.toHaveBeenCalled();
  });

  it("never touches the hook while the overlay is hidden", () => {
    const { manager, setIgnoreMouseEvents } = buildManager({ visible: false });

    manager._refreshMainWindowInteractivity("resume");
    vi.advanceTimersByTime(5000);

    expect(setIgnoreMouseEvents).not.toHaveBeenCalled();
  });

  it("re-clamps position on every recovery stage but re-arms only on the last", () => {
    const { manager } = buildManager();
    const reclamp = vi.fn();
    const refresh = vi.fn();
    manager._reclampOverlayPosition = reclamp;
    manager._refreshMainWindowInteractivity = refresh;
    manager._clearOverlayRecoveryTimers = () => manager._overlayRecoveryTimers.clear();

    manager._scheduleOverlayRecovery("unlock-screen", [500, 2500, 6000]);
    vi.advanceTimersByTime(6000);

    // Position needs every stage: Windows reports the wrong work area for a
    // while after a wake. The hook only needs the settled one.
    expect(reclamp).toHaveBeenCalledTimes(3);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refresh.mock.calls[0][0]).toContain("6000");
  });
});
