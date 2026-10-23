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

test("an import never lowers the history limit, which would delete history", async ({
  electronApp,
  controlPanel,
}) => {
  await seedPreferences(controlPanel);
  await electronApp.evaluate(({ ipcMain }) => {
    const calls: unknown[] = [];
    (globalThis as any).__historyLimitCalls = calls;
    ipcMain.removeHandler("set-history-limit");
    ipcMain.handle("set-history-limit", (_event, limit) => {
      calls.push(limit);
      return { success: true };
    });
  });
  const limitCalls = () =>
    electronApp.evaluate(() => [...((globalThis as any).__historyLimitCalls as unknown[])]);

  const message = await importSettings(controlPanel, { historyLimit: 10 }, true);
  expect(message).toContain("historyLimit");
  expect(await controlPanel.evaluate(() => localStorage.getItem("historyLimit"))).toBe("50");
  expect(await limitCalls()).not.toContain(10);

  await importSettings(controlPanel, { historyLimit: 20000 });
  expect(await controlPanel.evaluate(() => localStorage.getItem("historyLimit"))).toBe("20000");
  expect(await limitCalls()).toContain(20000);
});

test("an import keeps a speech engine idle shutdown of 0", async ({ controlPanel }) => {
  await seedPreferences(controlPanel);
  await importSettings(controlPanel, { whisperServerIdleTimeoutMinutes: 0 });
  expect(
    await controlPanel.evaluate(() => localStorage.getItem("whisperServerIdleTimeoutMinutes"))
  ).toBe("0");
});

test("an imported dictation hotkey is registered at once, and a refused one is not saved", async ({
  electronApp,
  controlPanel,
}) => {
  await seedPreferences(controlPanel);
  await electronApp.evaluate(({ ipcMain }) => {
    const calls: string[] = [];
    (globalThis as any).__hotkeyCalls = calls;
    ipcMain.removeHandler("update-hotkey");
    ipcMain.handle("update-hotkey", (_event, hotkey) => {
      calls.push(hotkey);
      return hotkey === "CommandOrControl+Shift+F9"
        ? { success: true, hotkey }
        : { success: false, message: "Another app already uses this key." };
    });
  });
  const hotkeyCalls = () =>
    electronApp.evaluate(() => [...((globalThis as any).__hotkeyCalls as string[])]);
  const storedKey = () => controlPanel.evaluate(() => localStorage.getItem("dictationKey"));

  // Saving the key alone left the old one working until the app restarted.
  await importSettings(controlPanel, { dictationKey: "CommandOrControl+Shift+F9" });
  expect(await hotkeyCalls()).toEqual(["CommandOrControl+Shift+F9"]);
  expect(await storedKey()).toBe("CommandOrControl+Shift+F9");

  const message = await importSettings(controlPanel, { dictationKey: "F7" }, true);
  expect(message).toContain("dictationKey");
  expect(await storedKey()).toBe("CommandOrControl+Shift+F9");
});
