import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures/electron-app";

test.use({ useThrowawayHome: true });

const preferences = {
  readAloudVoice: "af_heart",
  readAloudSpeed: 1.5,
  voiceCallMuteKey: "Mouse4",
  muteVoiceCallOnRecord: true,
};

async function seedPreferences(page: Page) {
  await page.evaluate((values) => {
    for (const [key, value] of Object.entries(values)) localStorage.setItem(key, String(value));
  }, preferences);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Data & Storage", exact: true }).click();
}

async function exportSettings(page: Page) {
  // Capture the real Export button's JSON Blob. Electron does not expose
  // renderer Blob downloads through Playwright's download event reliably.
  const capture = await page.evaluateHandle(() => {
    let resolve!: (json: string) => void;
    const exported = new Promise<string>((done) => {
      resolve = done;
    });
    const original = URL.createObjectURL;
    URL.createObjectURL = (blob) => {
      if (blob instanceof Blob && blob.type === "application/json") {
        URL.createObjectURL = original;
        void blob.text().then(resolve);
      }
      return original.call(URL, blob);
    };
    const click = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      if (this.download.startsWith("privatetranscribe-settings")) {
        HTMLAnchorElement.prototype.click = click;
      } else {
        click.call(this);
      }
    };
    return { exported };
  });
  await page.getByRole("button", { name: "Export", exact: true }).click();
  const json = await capture.evaluate(async ({ exported }) => await exported);
  await capture.dispose();
  return JSON.parse(json);
}

async function importSettings(page: Page, settings: Record<string, unknown>, skipped = false) {
  await page.locator('input[type="file"]').setInputFiles({
    name: "preferences.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify({ schemaVersion: 1, settings })),
  });
  await page
    .getByRole("dialog", { name: "Import Settings", exact: true })
    .getByRole("button", { name: "Import", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: skipped ? "Settings Imported With Skips" : "Settings Imported",
    exact: true,
  });
  await expect(dialog).toBeVisible();
  const message = await dialog.innerText();
  await dialog.getByRole("button", { name: "OK", exact: true }).click();
  return message;
}

test("exports and restores reading and call-mute preferences without exporting API keys", async ({
  controlPanel,
}) => {
  await seedPreferences(controlPanel);
  const backup = await exportSettings(controlPanel);
  expect(backup.schemaVersion).toBe(1);
  expect(backup.settings).toMatchObject(preferences);
  expect(backup.settings.apiKeys).toBeUndefined();

  const changed = {
    readAloudVoice: "bm_lewis",
    readAloudSpeed: 0.75,
    voiceCallMuteKey: "",
    muteVoiceCallOnRecord: false,
  };
  await importSettings(controlPanel, changed);
  // Export immediately, without reloading: this also catches stale callback dependencies.
  expect((await exportSettings(controlPanel)).settings).toMatchObject(changed);
  // Existing validators report empty optional defaults in a fresh profile.
  // The newly covered preferences must restore even when other fields are skipped.
  const message = await importSettings(controlPanel, backup.settings, true);
  for (const field of Object.keys(preferences)) expect(message).not.toContain(`${field}:`);
  expect((await exportSettings(controlPanel)).settings).toMatchObject(preferences);
  expect(
    await controlPanel.evaluate(() => ({
      voice: localStorage.getItem("readAloudVoice"),
      speed: localStorage.getItem("readAloudSpeed"),
      key: localStorage.getItem("voiceCallMuteKey"),
      enabled: localStorage.getItem("muteVoiceCallOnRecord"),
    }))
  ).toEqual({ voice: "af_heart", speed: "1.5", key: "Mouse4", enabled: "true" });
});

test("older backups leave the newly covered preferences unchanged", async ({ controlPanel }) => {
  await seedPreferences(controlPanel);
  await importSettings(controlPanel, { audioFeedback: true });
  expect((await exportSettings(controlPanel)).settings).toMatchObject({
    ...preferences,
    audioFeedback: true,
  });
});

test("invalid preference values are reported and leave current values unchanged", async ({
  controlPanel,
}) => {
  await seedPreferences(controlPanel);
  const message = await importSettings(
    controlPanel,
    {
      readAloudVoice: "unknown_voice",
      readAloudSpeed: 1.1,
      voiceCallMuteKey: "C:\\unsafe\\shortcut",
      muteVoiceCallOnRecord: "true",
      audioFeedback: true,
    },
    true
  );
  for (const field of Object.keys(preferences)) expect(message).toContain(field);
  expect((await exportSettings(controlPanel)).settings).toMatchObject({
    ...preferences,
    audioFeedback: true,
  });
});

test("rejects invalid types and control characters while accepting a cleared mute shortcut", async ({
  controlPanel,
}) => {
  await seedPreferences(controlPanel);
  for (const voiceCallMuteKey of [null, 123, "Mouse4\nF9", "../shortcut"]) {
    const message = await importSettings(
      controlPanel,
      {
        readAloudVoice: null,
        readAloudSpeed: "1.5",
        voiceCallMuteKey,
      },
      true
    );
    expect(message).toContain("readAloudVoice");
    expect(message).toContain("readAloudSpeed");
    expect(message).toContain("voiceCallMuteKey");
    expect((await exportSettings(controlPanel)).settings).toMatchObject(preferences);
  }
  await importSettings(controlPanel, {
    voiceCallMuteKey: "",
    readAloudSpeed: 2,
    readAloudVoice: "bf_emma",
  });
  expect((await exportSettings(controlPanel)).settings).toMatchObject({
    voiceCallMuteKey: "",
    readAloudSpeed: 2,
    readAloudVoice: "bf_emma",
  });
});
