import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures/electron-app";

/**
 * Ledger gate `readaloud-trigger-lag`: pressing the Read Aloud hotkey must not
 * stutter the machine.
 *
 * The press path is: worker round-trip (inject Ctrl+C) -> clipboard poll ->
 * IPC -> sentence split -> engine -> synthesis -> audio. Profiling showed the
 * copy worker was already persistent (spawned once at boot); the dominant cost
 * was the Kokoro engine lazily reading 326MB of weights inside the FIRST press
 * of a session. The fix pre-warms the engine when Read Aloud is armed
 * (readaloud-sync-hotkey), so a press only ever pays capture + synthesis.
 *
 * Both conditions live in this one harness so before/after stays reproducible:
 *
 *  - "cold baseline" runs measure the old world: no pre-warm (Read Aloud is
 *    not enabled, so sync never arms it), speak from a cold engine, and the
 *    engine wait lands inside the press. These are the BEFORE numbers.
 *  - "pre-warmed" runs seed `readAloudEnabled` and reload the overlay, wait
 *    for the engine to come up WITHOUT any press, then measure the press
 *    overhead. These are the AFTER numbers, and carry the gate's assertion.
 *
 * Per the gate, the worker itself is measured synthetically: a `ping` command
 * prices the line protocol round-trip without injecting a single keystroke.
 * No desktop automation, no clipboard writes, no microphone.
 *
 * Press overhead excluding synthesis is modeled as:
 *
 *   workerRtt + SETTLE_MS + one clipboard poll interval + (ttfa - synth)
 *
 * where (ttfa - synth) covers split + engine wait + audio scheduling. The
 * modifier-release wait is excluded on purpose: it measures how long the USER
 * holds the hotkey, not the app (readaloud-selection.spec.ts asserts it is
 * <50ms when nothing is held).
 */

/** Mirrors the worker's fixed post-release settle before SendWait('^c'). */
const SETTLE_MS = 40;
/** Mirrors CLIPBOARD_POLL_INTERVAL_MS in selectionCapture.js: one poll tick. */
const POLL_TICK_MS = 30;
/** The gate's bar for press-to-speak-start overhead, synthesis excluded. */
const OVERHEAD_BUDGET_MS = 150;

/** Two sentences so the split is real; the first is what TTFA measures. */
const TEXT =
  "The quick brown fox jumps over the lazy dog. A second sentence keeps the splitter honest.";

type PlayerState = {
  status: string;
  ttfaMs: number | null;
  lastSynthMs: number | null;
  splitMs: number | null;
  lastEngineWaitMs: number | null;
  lastCtxWaitMs: number | null;
  error: string | null;
};

async function medianWorkerRtt(overlay: Page, samples: number): Promise<number> {
  const rtts: number[] = [];
  for (let i = 0; i < samples; i++) {
    const probe = (await overlay.evaluate(
      async () => await (window as any).electronAPI.readAloudCaptureProbe()
    )) as { ok: boolean; rttMs: number | null; detail: string };
    expect(probe.ok, `worker probe ${i + 1} failed: ${probe.detail}`).toBe(true);
    rtts.push(probe.rttMs as number);
  }
  rtts.sort((a, b) => a - b);
  console.log(`WORKER_PING_RTT_MS=[${rtts.join(", ")}]`);
  return rtts[Math.floor(rtts.length / 2)];
}

/** Speak through the headless surface and wait for first audio (or an error). */
async function speakAndMeasure(overlay: Page, timeoutMs: number): Promise<PlayerState> {
  await overlay.waitForFunction(() => Boolean((window as any).__readAloudTest), null, {
    timeout: 15_000,
  });
  await overlay.evaluate((text) => {
    (window as any).__readAloudTest.speak(text);
  }, TEXT);

  const state = (await overlay.evaluate(async (budget) => {
    const deadline = Date.now() + budget;
    for (;;) {
      const current = (window as any).__readAloudTest.getState();
      if (current.ttfaMs !== null || current.status === "error" || Date.now() > deadline) {
        return current;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }, timeoutMs)) as PlayerState;

  expect(state.error, `player error: ${state.error}`).toBeNull();
  expect(state.ttfaMs, "speak never reached first audio").not.toBeNull();
  expect(state.lastSynthMs, "no synthesis time was recorded").not.toBeNull();
  return state;
}

function logRun(label: string, run: number, rtt: number, state: PlayerState) {
  const overhead =
    rtt + SETTLE_MS + POLL_TICK_MS + ((state.ttfaMs as number) - (state.lastSynthMs as number));
  console.log(
    `TRIGGER_LAG ${label} run=${run} rttMs=${rtt} splitMs=${state.splitMs} ` +
      `engineWaitMs=${state.lastEngineWaitMs} ctxWaitMs=${state.lastCtxWaitMs} ` +
      `synthMs=${state.lastSynthMs} ttfaMs=${state.ttfaMs} overheadMs=${Math.round(overhead)}`
  );
  return overhead;
}

test.use({ seedKokoroModel: true });

test.describe("read aloud trigger lag", () => {
  for (const run of [1, 2]) {
    test(`cold baseline: the first press pays the engine load (run ${run})`, async ({
      overlayWindow,
    }) => {
      // Read Aloud is NOT enabled, so nothing pre-warms: this is the world the
      // gate was opened about, kept reproducible as the BEFORE measurement.
      test.setTimeout(180_000);

      const rtt = await medianWorkerRtt(overlayWindow, 15);
      const statusBefore = (await overlayWindow.evaluate(
        async () => await (window as any).electronAPI.readAloudEngineStatus()
      )) as { loaded: boolean; coldStartMs?: number };
      console.log(`COLD_ENGINE_LOADED_BEFORE_SPEAK=${statusBefore.loaded}`);
      const state = await speakAndMeasure(overlayWindow, 120_000);
      const statusAfter = (await overlayWindow.evaluate(
        async () => await (window as any).electronAPI.readAloudEngineStatus()
      )) as { loaded: boolean; coldStartMs?: number };
      console.log(`COLD_ENGINE_COLDSTART_MS=${statusAfter.coldStartMs}`);
      console.log(`COLD_ENGINE_LOAD_REPLY=${(state as any).lastEngineLoadReply}`);
      const overhead = logRun("cold", run, rtt, state);

      // The point of the baseline: the engine wait dominates the press, and it
      // alone blows the budget the pre-warmed press has to meet.
      expect(state.lastEngineWaitMs as number, "cold press engine wait").toBeGreaterThan(
        OVERHEAD_BUDGET_MS
      );
      expect(overhead, "cold press overhead").toBeGreaterThan(OVERHEAD_BUDGET_MS);
    });
  }

  for (const run of [1, 2]) {
    test(`pre-warmed: press overhead excluding synthesis is <= ${OVERHEAD_BUDGET_MS}ms (run ${run})`, async ({
      overlayWindow,
    }) => {
      test.setTimeout(180_000);

      // Arm Read Aloud and restart the overlay's renderer: its cold-start sync
      // (App.jsx) now reports enabled=true and the main process pre-warms.
      await overlayWindow.evaluate(() => {
        localStorage.setItem("readAloudEnabled", "true");
      });
      await overlayWindow.reload({ waitUntil: "domcontentloaded" });

      // The engine must come up from the sync alone - no press, no speak. This
      // is the fix's core claim; before it, this wait never ends.
      const warmupStarted = Date.now();
      await expect
        .poll(
          async () =>
            (
              (await overlayWindow.evaluate(
                async () => await (window as any).electronAPI.readAloudEngineStatus()
              )) as { loaded: boolean }
            ).loaded,
          { timeout: 120_000, intervals: [500] }
        )
        .toBe(true);
      console.log(`PREWARM_WAIT_MS=${Date.now() - warmupStarted}`);

      const rtt = await medianWorkerRtt(overlayWindow, 15);
      const state = await speakAndMeasure(overlayWindow, 30_000);
      const overhead = logRun("prewarmed", run, rtt, state);

      // The engine wait must be gone from the press path entirely.
      expect(state.lastEngineWaitMs as number, "pre-warmed engine wait").toBeLessThan(50);
      expect(overhead, "press overhead excluding synthesis").toBeLessThanOrEqual(
        OVERHEAD_BUDGET_MS
      );
    });
  }
});
