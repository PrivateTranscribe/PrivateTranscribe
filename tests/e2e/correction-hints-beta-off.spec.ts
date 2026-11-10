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
import { formField, startStubServer } from "./fixtures/local-stub-server";
import { enableBetaFeatures } from "./fixtures/tester-access";

/**
 * With the Correction Memory beta off, a cloud provider gets no spelling hints
 * taken from confirmed corrections.
 *
 * The hints are kept in the recorder after a local Whisper dictation. They used
 * to be added to every cloud request too, beta on or off, until the next local
 * dictation or a restart. Words in the Dictionary are a different thing and are
 * still sent.
 *
 * One app session, as a user would have it: teach a correction, dictate
 * locally, switch to cloud transcription, turn the beta off. The cloud provider
 * is a stand-in on this PC that keeps what the app posts to it, so no audio
 * leaves the machine and no key is needed.
 */

const FIXTURE_DIR = path.resolve(__dirname, "..", "fixtures", "dictation");
const DICTIONARY_WORD = "Julsgaard";
const CORRECTION = { source: "banana", target: "Zephyr9000" };

test.use({
  fakeAudioCaptureFile: path.join(FIXTURE_DIR, "banana.wav"),
  seedRealWhisperModels: ["base"],
  appEnv: { WHISPER_FORCE_CPU: "true" },
});

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

test("no correction hints go to a cloud provider once the beta is off", async ({
  electronApp,
  overlayWindow,
  controlPanel,
}) => {
  test.setTimeout(420_000);

  const provider = await startStubServer((_request, reply) =>
    reply.json({ text: "I put the banana in my backpack yesterday." })
  );
  const uploads = () => provider.requests.filter((request) => request.method === "POST");

  try {
    await enableBetaFeatures(controlPanel);
    await recordPastes(electronApp);
    await configureLocalWhisperDictation(overlayWindow, {
      [BETA_FEATURES_KEY]: "true",
      enableVariableSnapping: "true",
      customDictionary: JSON.stringify([DICTIONARY_WORD]),
    });

    // Teach one correction through the app's own form.
    await controlPanel.getByRole("button", { name: "Dictionary", exact: true }).click();
    await controlPanel.locator("summary").filter({ hasText: "Correction Memory" }).click();
    await controlPanel.getByPlaceholder("Source word - e.g. cloud").fill(CORRECTION.source);
    await controlPanel.getByPlaceholder("Replacement word - e.g. Claude").fill(CORRECTION.target);
    await controlPanel.getByRole("button", { name: "Add correction", exact: true }).click();
    await expect(controlPanel.getByText("1 entry", { exact: true })).toBeVisible();

    // A local dictation with the beta on. This is what leaves the hints in the
    // recorder. The correction is applied, so the memory is really in use.
    expect(await dictate(electronApp, overlayWindow, 1)).toContain(CORRECTION.target);
    expect(uploads()).toHaveLength(0);

    // Switch to cloud transcription in the other window, as Settings does. The
    // overlay is not reloaded: a reload would empty the recorder and hide the bug.
    await controlPanel.evaluate((baseUrl) => {
      localStorage.setItem("useLocalWhisper", "false");
      localStorage.setItem("cloudTranscriptionProvider", "custom");
      localStorage.setItem("cloudTranscriptionBaseUrl", baseUrl);
    }, `${provider.url}/v1`);

    // Beta still on: the hints are meant to go along, and they do.
    await dictate(electronApp, overlayWindow, 2);
    expect(uploads()).toHaveLength(1);
    const promptWithBetaOn = formField(uploads()[0], "prompt") ?? "";
    expect(promptWithBetaOn).toContain(DICTIONARY_WORD);
    expect(promptWithBetaOn).toContain(CORRECTION.target);

    // Beta off.
    await controlPanel.evaluate((key) => localStorage.setItem(key, "false"), BETA_FEATURES_KEY);

    await dictate(electronApp, overlayWindow, 3);
    expect(uploads()).toHaveLength(2);
    const promptWithBetaOff = formField(uploads()[1], "prompt") ?? "";
    expect(promptWithBetaOff, "the Dictionary word is no longer sent").toContain(DICTIONARY_WORD);
    expect(promptWithBetaOff, "a correction hint was sent with the beta off").not.toContain(
      CORRECTION.target
    );
  } finally {
    await provider.close();
  }
});
