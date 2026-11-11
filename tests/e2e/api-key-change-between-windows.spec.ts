import path from "node:path";
import type { ElectronApplication, Page } from "@playwright/test";
import { BETA_FEATURES_KEY } from "../../src/utils/betaFeatures";
import { expect, test } from "./fixtures/electron-app";
import {
  configureLocalWhisperDictation,
  readPastes,
  recordingHalo,
  recordPastes,
  toggleDictation,
} from "./fixtures/app-drive";
import { unlockTesterAccess } from "./fixtures/tester-access";

/**
 * An API key changed in the control panel is used by the next dictation
 * cleanup, which runs in the other window.
 *
 * Each window has its own cleanup service, and the service used to keep a copy
 * of the key for an hour. Saving a new key dropped the copy in the control
 * panel only, so the dictation overlay went on sending the old one.
 *
 * Both windows are the real ones here. The key is typed into the control
 * panel's own field, twice. Each dictation goes through the fake microphone
 * and a real Whisper decode in the overlay, and the overlay is never reloaded
 * in between. The keys are made up. The request to OpenAI is caught inside the
 * app and answered here, and the app is started behind a proxy address nothing
 * listens on, so a request from a window that slipped past would fail on this
 * PC and never reach a provider. The cleanup request is made by the window.
 */

const FIXTURE_DIR = path.resolve(__dirname, "..", "fixtures", "dictation");
const FIRST_KEY = "e2e-made-up-key-one";
const SECOND_KEY = "e2e-made-up-key-two";

test.use({
  fakeAudioCaptureFile: path.join(FIXTURE_DIR, "banana.wav"),
  seedRealWhisperModels: ["base"],
  appEnv: { WHISPER_FORCE_CPU: "true" },
  appArgs: ["--proxy-server=http://127.0.0.1:9"],
});

type CaughtRequest = { url: string; authorization: string; fromOverlay: boolean };

/** Two passes of the six-second clip, so one whole sentence is always in it. */
async function dictate(app: ElectronApplication, overlay: Page, pasteNumber: number) {
  await toggleDictation(app);
  await expect(recordingHalo(overlay)).toHaveCount(1, { timeout: 30_000 });
  await overlay.waitForTimeout(12_000);
  await toggleDictation(app);
  await expect
    .poll(async () => (await readPastes(app)).length, { timeout: 120_000 })
    .toBe(pasteNumber);
  return (await readPastes(app))[pasteNumber - 1].text;
}

test("a key changed in the control panel is sent by the overlay's next cleanup", async ({
  electronApp,
  overlayWindow,
  controlPanel,
}) => {
  test.setTimeout(300_000);

  // Catch every request to OpenAI before it leaves the app, and answer it.
  const caught: CaughtRequest[] = [];
  await electronApp.context().route("https://api.openai.com/**", async (route) => {
    const request = route.request();
    const headers = await request.allHeaders();
    caught.push({
      url: request.url(),
      authorization: headers["authorization"] ?? "",
      fromOverlay: request.frame().page() === overlayWindow,
    });
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({
        id: "resp_e2e",
        object: "response",
        status: "completed",
        output: [
          {
            type: "message",
            role: "assistant",
            content: [
              { type: "output_text", text: `Cleaned by request ${caught.length}: the banana.` },
            ],
          },
        ],
      }),
    });
  });

  // The proxy that is not there is what the overlay would use for OpenAI.
  expect(
    await electronApp.evaluate(({ BrowserWindow }) => {
      const overlay = BrowserWindow.getAllWindows().find(
        (win) => !win.webContents.getURL().includes("panel=true")
      );
      return overlay!.webContents.session.resolveProxy("https://api.openai.com/v1/responses");
    })
  ).toBe("PROXY 127.0.0.1:9");

  await recordPastes(electronApp);
  await configureLocalWhisperDictation(overlayWindow, { [BETA_FEATURES_KEY]: "true" });

  // In the control panel: cleanup on, through OpenAI, with the first key.
  await unlockTesterAccess(controlPanel);
  await controlPanel.getByRole("button", { name: "AI Enhancement", exact: true }).click();
  await controlPanel.getByRole("button", { name: "Enable AI enhancement" }).click();
  await controlPanel.getByRole("combobox", { name: "Enhance using", exact: true }).click();
  await controlPanel.getByRole("option", { name: "API provider", exact: true }).click();
  await expect
    .poll(() => controlPanel.evaluate(() => localStorage.getItem("reasoningProvider")))
    .toBe("openai");
  const keyField = controlPanel.getByLabel("OpenAI API key", { exact: true });
  await keyField.fill(FIRST_KEY);
  await expect
    .poll(() => controlPanel.evaluate(() => window.electronAPI.getOpenAIKey()))
    .toBe(FIRST_KEY);

  // First dictation: the overlay's cleanup carries the first key.
  expect(await dictate(electronApp, overlayWindow, 1)).toBe("Cleaned by request 1: the banana.");
  expect(caught).toHaveLength(1);
  expect(caught[0].fromOverlay, "the cleanup did not come from the dictation overlay").toBe(true);
  expect(caught[0].authorization).toBe(`Bearer ${FIRST_KEY}`);

  // The key is replaced in the control panel. The overlay is left as it is.
  await keyField.fill(SECOND_KEY);
  await expect
    .poll(() => controlPanel.evaluate(() => window.electronAPI.getOpenAIKey()))
    .toBe(SECOND_KEY);

  // Second dictation: the same overlay sends the new key.
  expect(await dictate(electronApp, overlayWindow, 2)).toBe("Cleaned by request 2: the banana.");
  expect(caught).toHaveLength(2);
  expect(caught[1].fromOverlay, "the cleanup did not come from the dictation overlay").toBe(true);
  expect(caught[1].authorization, "the overlay sent the key it was given before the change").toBe(
    `Bearer ${SECOND_KEY}`
  );
});
