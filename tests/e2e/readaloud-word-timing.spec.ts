import { expect, test } from "./fixtures/electron-app";
test.use({ seedKokoroModel: true });

test("word timings follow real audio through chunks, pause and seek", async ({ overlayWindow }) => {
  test.setTimeout(90000);
  await overlayWindow.waitForFunction(() => Boolean((window as any).__readAloudTest));
  await overlayWindow.evaluate(async () => await (window as any).electronAPI.readAloudLoadEngine());
  const first =
    "A quiet morning makes room for a little reading, while the rest of the world begins another busy day.";
  const result = await overlayWindow.evaluate(async (text) => {
    const player = (window as any).__readAloudTest;
    await player.speak(text + " Another sentence follows.");
    const seen: any[] = [];
    await new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + 20000;
      const timer = setInterval(() => {
        const state = player.getState();
        if (
          state.currentWord &&
          state.index === 0 &&
          seen.at(-1)?.start !== state.currentWord.start
        )
          seen.push(state.currentWord);
        if (state.index === 1) {
          player.pause();
          clearInterval(timer);
          resolve();
        } else if (Date.now() > deadline) {
          clearInterval(timer);
          reject(new Error("Playback stalled"));
        }
      }, 10);
    });
    player.seek(-1);
    player.resume();
    await new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + 10000;
      const timer = setInterval(() => {
        const state = player.getState();
        if (state.currentWord?.text === "morning") {
          player.pause();
          clearInterval(timer);
          resolve();
        } else if (Date.now() > deadline) {
          clearInterval(timer);
          reject(new Error("Resume did not reach word"));
        }
      }, 10);
    });
    const paused = player.getState();
    await new Promise((resolve) => setTimeout(resolve, 200));
    const held = player.getState();
    player.resume();
    await new Promise((resolve) => setTimeout(resolve, 80));
    const resumed = player.getState();
    player.stop();
    return { seen, paused, held, resumed, stopped: player.getState() };
  }, first);
  expect(result.seen.map((word) => word.text)).toEqual(first.match(/\S+/g));
  for (const word of result.seen) expect(first.slice(word.start, word.end)).toBe(word.text);
  expect(result.paused.currentWord.text).toBe("morning");
  expect(result.held.currentWord).toEqual(result.paused.currentWord);
  expect(result.resumed.currentWord.text).toBe("morning");
  expect(result.stopped.currentWord).toBeNull();
});
