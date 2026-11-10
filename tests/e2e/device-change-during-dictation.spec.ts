import path from "node:path";
import { expect, test } from "./fixtures/electron-app";

/**
 * Windows reports a device change whenever any audio endpoint comes or goes: a
 * headset connecting, a dock, a monitor waking. The app used to close its warm
 * microphone stream on that event even while a dictation was recording from
 * it, which ended the recording mid-sentence.
 */
test.use({
  fakeAudioCaptureFile: path.resolve("tests/fixtures/dictation/banana.wav"),
});

test("a device change during a dictation leaves the microphone recording", async ({
  electronApp,
  overlayWindow,
}) => {
  await overlayWindow.evaluate(() => {
    localStorage.setItem("autoPaste", "false");
    localStorage.setItem("copyToClipboard", "false");
    localStorage.setItem("audioFeedback", "false");
    localStorage.setItem("useReasoningModel", "false");
  });
  await overlayWindow.reload();
  await expect(overlayWindow.getByRole("button", { name: "Dictation overlay" })).toBeVisible();

  // Count every microphone track the page stops, and keep the tracks so the
  // test can read their state afterwards.
  await overlayWindow.evaluate(() => {
    const probe = { stops: 0, tracks: [] as MediaStreamTrack[] };
    (window as unknown as { __micProbe: typeof probe }).__micProbe = probe;
    const getUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      const stream = await getUserMedia(constraints);
      probe.tracks.push(...stream.getAudioTracks());
      return stream;
    };
    const stop = MediaStreamTrack.prototype.stop;
    MediaStreamTrack.prototype.stop = function () {
      probe.stops += 1;
      return stop.call(this);
    };
  });

  await electronApp.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()
      .find((win) => !win.webContents.getURL().includes("panel=true"))!
      .webContents.send("start-dictation");
  });

  // The level bars only appear once a microphone stream is recording.
  const levelBars = overlayWindow.locator('div[style*="scaleY("]');
  await expect(levelBars).toHaveCount(5);

  await overlayWindow.evaluate(() => {
    navigator.mediaDevices.dispatchEvent(new Event("devicechange"));
  });
  await overlayWindow.waitForTimeout(1000);

  const probe = await overlayWindow.evaluate(() => {
    const { stops, tracks } = (
      window as unknown as { __micProbe: { stops: number; tracks: MediaStreamTrack[] } }
    ).__micProbe;
    return { stops, states: tracks.map((track) => track.readyState) };
  });
  expect(probe.states.length).toBeGreaterThan(0);
  expect(probe).toEqual({ stops: 0, states: probe.states.map(() => "live") });
  await expect(levelBars).toHaveCount(5);
});
