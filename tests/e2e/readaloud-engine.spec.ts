import { expect, test } from "./fixtures/electron-app";

/**
 * Ledger gate `readaloud-engine-in-app`: prove Kokoro TTS actually synthesizes
 * and plays inside the app, five runs in a row, fast enough to be usable.
 *
 * The model is the real one, hardlinked into a throwaway home by the fixture —
 * there is no mock here, and no `test.skip` if the model is absent. A missing
 * model makes the fixture throw, because a silently skipped run would hide the
 * exact thing this gate is measuring.
 */

/** Fixed input: three sentences, ~40 words, unambiguous sentence boundaries. */
const THREE_SENTENCES = [
  "The model runs entirely on this machine, so nothing you dictate ever leaves it.",
  "Each sentence is synthesized on its own and queued before the previous one ends.",
  "Press the key again and playback stops exactly where you left it.",
].join(" ");

const RUNS = 5;
const TTFA_BUDGET_MS = 2000;

type ReadAloudState = {
  status: string;
  sentenceCount: number;
  index: number;
  playing: boolean;
  ttfaMs: number | null;
  lastSynthMs: number | null;
  engineLoaded: boolean;
  error: string | null;
};

test.use({ seedKokoroModel: true });

test.describe("read aloud engine", () => {
  // Five synthesis runs plus a cold model load; the default 30s cannot cover it.
  test.setTimeout(180_000);

  test("synthesizes and plays a three-sentence text five times", async ({ overlayWindow }) => {
    await overlayWindow.waitForFunction(() => Boolean((window as any).__readAloudTest), null, {
      timeout: 30_000,
    });

    // Cold model load is a separate step from time-to-first-audio: the budget
    // covers synthesis and playback startup, not reading 326MB of weights off
    // disk into onnxruntime. Paying it here keeps run 1 comparable to runs 2-5.
    const engineStatus = await overlayWindow.evaluate(
      async () => await (window as any).electronAPI.readAloudLoadEngine()
    );
    expect(engineStatus.loaded, `engine failed to load: ${engineStatus.error}`).toBe(true);

    const ttfaValues: number[] = [];

    for (let run = 1; run <= RUNS; run++) {
      // Clearing the cache is what makes each run a real synthesis rather than
      // a replay of buffers the previous run already produced.
      await overlayWindow.evaluate(() => {
        (window as any).__readAloudTest.stop();
        (window as any).__readAloudTest.clearCache();
      });

      await overlayWindow.evaluate((text) => {
        // Not awaited: speak() resolves only once playback has started, and the
        // poll below is what measures reaching that state.
        (window as any).__readAloudTest.speak(text);
      }, THREE_SENTENCES);

      const state: ReadAloudState = await overlayWindow.evaluate(async () => {
        const surface = (window as any).__readAloudTest;
        const deadline = Date.now() + 15_000;
        for (;;) {
          const current = surface.getState();
          if (current.playing || current.status === "error" || Date.now() > deadline) {
            return current;
          }
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      });

      expect(state.error, `run ${run} errored`).toBeNull();
      expect(state.playing, `run ${run} never reached playing (status: ${state.status})`).toBe(true);
      expect(state.sentenceCount, `run ${run} sentence count`).toBe(3);
      expect(state.ttfaMs, `run ${run} produced no TTFA measurement`).not.toBeNull();
      expect(state.ttfaMs as number, `run ${run} time-to-first-audio`).toBeLessThan(TTFA_BUDGET_MS);

      ttfaValues.push(state.ttfaMs as number);

      if (run === 1) {
        // A fast TTFA over a silent buffer would be meaningless. Assert the
        // first sentence actually decoded to audible audio of a plausible
        // length, so the number cannot be gamed.
        const stats = await overlayWindow.evaluate(() =>
          (window as any).__readAloudTest.getFirstBufferStats()
        );
        expect(stats, "no decoded buffer for the first sentence").not.toBeNull();
        expect(stats.durationSec, "first sentence duration").toBeGreaterThan(0.5);
        expect(stats.rms, "first sentence RMS (silence check)").toBeGreaterThan(0.01);
      }
    }

    await overlayWindow.evaluate(() => (window as any).__readAloudTest.stop());

    // Single line so the ledger's numbers can be read straight from the runner.
    console.log(`TTFA_MS=[${ttfaValues.join(", ")}]`);

    expect(ttfaValues).toHaveLength(RUNS);
  });
});
