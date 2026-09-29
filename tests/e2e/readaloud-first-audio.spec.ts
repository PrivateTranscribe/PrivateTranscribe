import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures/electron-app";
import { DEFAULT_KOKORO_VOICE_ID, VOICE_STORAGE_KEY } from "../../src/models/kokoroVoices";

/**
 * Ledger gate `readaloud-first-audio`: the press should speak sooner than half
 * a second.
 *
 * `readaloud-trigger-lag` already took the engine load out of the press, which
 * left synthesis as the whole remaining wait: the first sentence of the
 * standard fixture is 79 characters and takes ~475ms to synthesize warm, so
 * first audio landed around 570ms after the hotkey. Kokoro's cost scales with
 * text length (measured: 26 chars ~213ms, 40 chars ~274ms, 79 chars ~475ms),
 * so the fix is to speak the head of the first sentence while its tail is
 * still being synthesized.
 *
 * Both conditions live in this one file so the comparison is same-machine,
 * same-session, same-fixture:
 *
 *  - "full first sentence" runs launch with
 *    PRIVATETRANSCRIBE_DIAG_DISABLE_FIRST_CHUNK=1, which is the old behaviour
 *    exactly. These are the BEFORE numbers.
 *  - "first chunk" runs launch normally. These carry the gate's assertions.
 *
 * press→first-audio is modeled the way readaloud-trigger-lag models press
 * overhead — worker round-trip, the worker's fixed settle, one clipboard poll
 * tick — plus the player's own time-to-first-audio. No desktop automation, no
 * clipboard writes, no microphone.
 */

/** Mirrors the worker's fixed post-release settle before SendWait('^c'). */
const SETTLE_MS = 40;
/** Mirrors CLIPBOARD_POLL_INTERVAL_MS in selectionCapture.js: one poll tick. */
const POLL_TICK_MS = 30;

/**
 * The gate's bar for warm press→first-audio, median of 5, in the default voice.
 *
 * It was 350ms, met with Heart. Lewis became the default on 2026-08-30 and
 * speaks the same head chunk as 3.0s of audio against Heart's 2.3s, ~50ms more
 * synthesis. The same machine measured 338ms with Heart and 367-382ms with
 * Lewis, so on 2026-09-29 Kristian moved the bar to 400ms rather than time a
 * voice nobody hears by default. A new default voice means measuring again.
 */
const FIRST_AUDIO_BUDGET_MS = 400;
/** The gate also requires this much improvement over the same-run baseline. */
const REQUIRED_IMPROVEMENT = 0.3;
const RUNS = 5;

/** The standard fixture: the same three sentences readaloud-engine.spec.ts uses. */
const THREE_SENTENCES = [
  "The model runs entirely on this machine, so nothing you dictate ever leaves it.",
  "Each sentence is synthesized on its own and queued before the previous one ends.",
  "Press the key again and playback stops exactly where you left it.",
].join(" ");

const FIRST_SENTENCE = "The model runs entirely on this machine, so nothing you dictate ever leaves it.";

type PlayerState = {
  status: string;
  sentenceCount: number;
  index: number;
  currentSentence: string | null;
  playing: boolean;
  ttfaMs: number | null;
  lastSynthMs: number | null;
  splitMs: number | null;
  lastEngineWaitMs: number | null;
  error: string | null;
};

/** Both conditions share one module scope so the second can compare to the first. */
const medians: { baseline: number | null; chunked: number | null } = {
  baseline: null,
  chunked: null,
};

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

async function medianWorkerRtt(overlay: Page, samples: number): Promise<number> {
  const rtts: number[] = [];
  for (let i = 0; i < samples; i++) {
    const probe = (await overlay.evaluate(
      async () => await (window as any).electronAPI.readAloudCaptureProbe()
    )) as { ok: boolean; rttMs: number | null; detail: string };
    expect(probe.ok, `worker probe ${i + 1} failed: ${probe.detail}`).toBe(true);
    rtts.push(probe.rttMs as number);
  }
  return median(rtts);
}

/**
 * Warm the engine outside the measurement, then time five presses. Returns the
 * median modeled press→first-audio in ms.
 */
async function measureCondition(overlay: Page, label: string): Promise<number> {
  await overlay.waitForFunction(() => Boolean((window as any).__readAloudTest), null, {
    timeout: 30_000,
  });

  // The bar is set for the default voice, and speak() re-reads the stored one
  // before every run, so pin it rather than trust the profile.
  await overlay.evaluate(({ key, voice }) => localStorage.setItem(key, voice), {
    key: VOICE_STORAGE_KEY,
    voice: DEFAULT_KOKORO_VOICE_ID,
  });

  // The gate says "warm", and readaloud-trigger-lag already proved the pre-warm
  // works. Paying the 326MB load here keeps every one of the five runs warm.
  const engineStatus = (await overlay.evaluate(
    async () => await (window as any).electronAPI.readAloudLoadEngine()
  )) as { loaded: boolean; error?: string };
  expect(engineStatus.loaded, `engine failed to load: ${engineStatus.error}`).toBe(true);

  const rtt = await medianWorkerRtt(overlay, 15);
  const pressPathMs = rtt + SETTLE_MS + POLL_TICK_MS;

  const pressToAudio: number[] = [];
  const ttfas: number[] = [];
  const synths: number[] = [];

  for (let run = 1; run <= RUNS; run++) {
    // Without this every run after the first would replay cached buffers and
    // measure a Map lookup instead of synthesis.
    await overlay.evaluate(() => {
      (window as any).__readAloudTest.stop();
      (window as any).__readAloudTest.clearCache();
    });

    await overlay.evaluate((text) => {
      (window as any).__readAloudTest.speak(text);
    }, THREE_SENTENCES);

    const state = (await overlay.evaluate(async () => {
      const surface = (window as any).__readAloudTest;
      const deadline = Date.now() + 30_000;
      for (;;) {
        const current = surface.getState();
        if (current.ttfaMs !== null || current.status === "error" || Date.now() > deadline) {
          return current;
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    })) as PlayerState;

    expect(state.error, `${label} run ${run} errored`).toBeNull();
    expect(state.ttfaMs, `${label} run ${run} never reached first audio`).not.toBeNull();
    expect(state.lastSynthMs, `${label} run ${run} recorded no synthesis time`).not.toBeNull();

    // The gate's invisibility clause, checked at the exact moment chunking is
    // in effect: the counter, the index and the sentence line must all still
    // describe whole sentences.
    expect(state.sentenceCount, `${label} run ${run} sentence count`).toBe(3);
    expect(state.index, `${label} run ${run} index`).toBe(0);
    expect(state.currentSentence, `${label} run ${run} sentence line`).toBe(FIRST_SENTENCE);

    const total = pressPathMs + (state.ttfaMs as number);
    pressToAudio.push(total);
    ttfas.push(state.ttfaMs as number);
    synths.push(state.lastSynthMs as number);

    console.log(
      `FIRST_AUDIO ${label} run=${run} rttMs=${rtt} splitMs=${state.splitMs} ` +
        `engineWaitMs=${state.lastEngineWaitMs} synthMs=${state.lastSynthMs} ` +
        `ttfaMs=${state.ttfaMs} pressToFirstAudioMs=${Math.round(total)}`
    );
  }

  await overlay.evaluate(() => (window as any).__readAloudTest.stop());

  const result = Math.round(median(pressToAudio));
  console.log(`FIRST_AUDIO_${label.toUpperCase()}_TTFA_MS=[${ttfas.join(", ")}]`);
  console.log(`FIRST_AUDIO_${label.toUpperCase()}_SYNTH_MS=[${synths.join(", ")}]`);
  console.log(
    `FIRST_AUDIO_${label.toUpperCase()}_PRESS_TO_AUDIO_MS=[${pressToAudio
      .map((value) => Math.round(value))
      .join(", ")}] median=${result}`
  );
  return result;
}

test.describe.configure({ mode: "serial" });

test.describe("read aloud first audio — full first sentence (baseline)", () => {
  test.use({
    seedKokoroModel: true,
    appEnv: { PRIVATETRANSCRIBE_DIAG_DISABLE_FIRST_CHUNK: "1" },
  });

  test("synthesizes the whole first sentence before any audio", async ({ overlayWindow }) => {
    test.setTimeout(300_000);
    medians.baseline = await measureCondition(overlayWindow, "baseline");
    expect(medians.baseline).toBeGreaterThan(0);
  });
});

test.describe("read aloud first audio — first chunk", () => {
  test.use({ seedKokoroModel: true });

  test(`warm press→first-audio median of ${RUNS} is <= ${FIRST_AUDIO_BUDGET_MS}ms and >= ${
    REQUIRED_IMPROVEMENT * 100
  }% below baseline`, async ({ overlayWindow }) => {
    test.setTimeout(300_000);

    medians.chunked = await measureCondition(overlayWindow, "chunked");

    expect(medians.baseline, "baseline condition did not record a median").not.toBeNull();
    const baseline = medians.baseline as number;
    const chunked = medians.chunked as number;
    const improvement = (baseline - chunked) / baseline;

    console.log(
      `FIRST_AUDIO_GATE voice=${DEFAULT_KOKORO_VOICE_ID} ` +
        `baselineMedianMs=${baseline} chunkedMedianMs=${chunked} ` +
        `improvement=${(improvement * 100).toFixed(1)}%`
    );

    expect(chunked, "warm press to first audio, median of 5").toBeLessThanOrEqual(
      FIRST_AUDIO_BUDGET_MS
    );
    expect(improvement, "improvement over the full-first-sentence baseline").toBeGreaterThanOrEqual(
      REQUIRED_IMPROVEMENT
    );
  });

  test("the chunk seam is a real boundary, and the tail is still spoken", async ({
    overlayWindow,
  }) => {
    test.setTimeout(120_000);

    await overlayWindow.waitForFunction(() => Boolean((window as any).__readAloudTest), null, {
      timeout: 30_000,
    });
    await overlayWindow.evaluate(
      async () => await (window as any).electronAPI.readAloudLoadEngine()
    );

    await overlayWindow.evaluate(() => {
      (window as any).__readAloudTest.stop();
      (window as any).__readAloudTest.clearCache();
    });
    await overlayWindow.evaluate((text) => {
      (window as any).__readAloudTest.speak(text);
    }, THREE_SENTENCES);

    // Wait until both halves of sentence 0 have been decoded, then read the
    // combined stats: a fast-but-silent head would make the gate meaningless.
    await expect
      .poll(
        async () =>
          (await overlayWindow.evaluate(
            () => (window as any).__readAloudTest.getFirstBufferStats()?.durationSec ?? 0
          )) as number,
        { timeout: 60_000, intervals: [100] }
      )
      .toBeGreaterThan(4);

    const stats = (await overlayWindow.evaluate(() =>
      (window as any).__readAloudTest.getFirstBufferStats()
    )) as { durationSec: number; rms: number };
    console.log(
      `FIRST_AUDIO_CHUNK_STATS durationSec=${stats.durationSec.toFixed(2)} rms=${stats.rms.toFixed(4)}`
    );
    // The unchunked first sentence measures ~5.3s; head + tail must add up to
    // the same speech, not to a truncated read.
    expect(stats.durationSec, "head + tail duration").toBeGreaterThan(4);
    expect(stats.durationSec, "head + tail duration").toBeLessThan(8);
    expect(stats.rms, "head + tail RMS (silence check)").toBeGreaterThan(0.01);

    // Chunking must leave nothing behind in the sentence-facing state.
    const state = (await overlayWindow.evaluate(() =>
      (window as any).__readAloudTest.getState()
    )) as PlayerState;
    expect(state.sentenceCount).toBe(3);
    expect(state.currentSentence).toBe(FIRST_SENTENCE);
    expect(Object.keys(state)).not.toContain("firstChunks");

    await overlayWindow.evaluate(() => (window as any).__readAloudTest.stop());
  });
});
