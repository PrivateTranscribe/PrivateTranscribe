import { expect, test } from "./fixtures/electron-app";

/**
 * Ledger gate `readaloud-player-cursor`: pause, resume, and rewind land exactly
 * where the pre-computed sequence says they must.
 *
 * Determinism note: a playing sentence auto-advances on its own clock, so every
 * seek in this script happens while the player is paused (a paused seek moves
 * only the cursor), and each resume is asserted within the first sentence it
 * lands on — Kokoro sentences here are all > 2s of audio, far longer than one
 * poll round-trip. That is what makes the expected sequence computable up
 * front instead of a race against playback.
 */

const TWELVE_SENTENCES = [
  "The quick brown fox jumps over the lazy dog.",
  "A second sentence keeps the queue honest.",
  "Number three arrives right on schedule.",
  "Sentence four is happy to wait its turn.",
  "The fifth one has nothing special to say.",
  "Sentence six marks the halfway point.",
  "Lucky number seven follows immediately after.",
  "The eighth sentence is still in the queue.",
  "Sentence nine is nearly at the end.",
  "The tenth sentence can see the finish line.",
  "Sentence eleven is the penultimate one.",
  "The twelfth sentence closes out the text.",
].join(" ");

type Op = {
  name: "pause" | "resume" | "back1" | "back3" | "forward";
  expectedIndex: number;
  expectedPlaying: boolean;
};

/**
 * Ten operations covering all five controls, with boundary clamping exercised
 * at the bottom (back-3 from index 1, back-1 from index 0 both clamp to 0).
 */
const SCRIPT: Op[] = [
  { name: "pause", expectedIndex: 0, expectedPlaying: false },
  { name: "forward", expectedIndex: 1, expectedPlaying: false },
  { name: "forward", expectedIndex: 2, expectedPlaying: false },
  { name: "back1", expectedIndex: 1, expectedPlaying: false },
  { name: "resume", expectedIndex: 1, expectedPlaying: true },
  { name: "pause", expectedIndex: 1, expectedPlaying: false },
  { name: "back3", expectedIndex: 0, expectedPlaying: false },
  { name: "forward", expectedIndex: 1, expectedPlaying: false },
  { name: "back1", expectedIndex: 0, expectedPlaying: false },
  { name: "resume", expectedIndex: 0, expectedPlaying: true },
];

test.use({ seedKokoroModel: true });

test.describe("read aloud player cursor", () => {
  test.setTimeout(120_000);

  test("ten scripted operations land on the pre-computed sentence indices", async ({
    overlayWindow,
  }) => {
    await overlayWindow.waitForFunction(() => Boolean((window as any).__readAloudTest), null, {
      timeout: 30_000,
    });

    // Pay the cold model load before the script so no operation's poll window
    // absorbs it.
    const engineStatus = await overlayWindow.evaluate(
      async () => await (window as any).electronAPI.readAloudLoadEngine()
    );
    expect(engineStatus.loaded, `engine failed to load: ${engineStatus.error}`).toBe(true);

    await overlayWindow.evaluate((text) => {
      (window as any).__readAloudTest.speak(text);
    }, TWELVE_SENTENCES);

    // The script starts from a known state: sentence 0 audibly playing.
    const initial = await overlayWindow.evaluate(async () => {
      const surface = (window as any).__readAloudTest;
      const deadline = Date.now() + 20_000;
      for (;;) {
        const state = surface.getState();
        if ((state.playing && state.index === 0) || state.status === "error") return state;
        if (Date.now() > deadline) return state;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    });
    expect(initial.error, "player errored before the script began").toBeNull();
    expect(initial.playing, "playback never started").toBe(true);
    expect(initial.sentenceCount, "sentence split").toBe(12);
    expect(initial.index, "starting sentence").toBe(0);

    const observed: { index: number; playing: boolean }[] = [];

    for (const [step, op] of SCRIPT.entries()) {
      const state = await overlayWindow.evaluate(
        async ({ name, wantPlaying, wantIndex }) => {
          const surface = (window as any).__readAloudTest;
          if (name === "pause") surface.pause();
          else if (name === "resume") surface.resume();
          else if (name === "back1") surface.seek(-1);
          else if (name === "back3") surface.seek(-3);
          else surface.seek(1);

          // Resume synthesizes the target sentence before audio starts, so the
          // settled state is polled rather than sampled immediately.
          const deadline = Date.now() + 10_000;
          for (;;) {
            const current = surface.getState();
            if (
              (current.playing === wantPlaying && current.index === wantIndex) ||
              current.status === "error" ||
              Date.now() > deadline
            ) {
              return current;
            }
            await new Promise((resolve) => setTimeout(resolve, 25));
          }
        },
        { name: op.name, wantPlaying: op.expectedPlaying, wantIndex: op.expectedIndex }
      );

      observed.push({ index: state.index, playing: state.playing });
      expect(state.error, `op ${step + 1} (${op.name}) errored`).toBeNull();
      expect(state.index, `op ${step + 1} (${op.name}) sentence index`).toBe(op.expectedIndex);
      expect(state.playing, `op ${step + 1} (${op.name}) playing flag`).toBe(op.expectedPlaying);
    }

    await overlayWindow.evaluate(() => (window as any).__readAloudTest.stop());

    // Single line so the ledger can quote the whole trajectory.
    console.log(
      `CURSOR_SEQUENCE=${observed.map((o) => `${o.index}${o.playing ? "P" : "p"}`).join(",")}`
    );
  });
});
