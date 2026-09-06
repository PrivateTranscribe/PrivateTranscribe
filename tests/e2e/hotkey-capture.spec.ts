import fs from "node:fs";
import path from "node:path";
import { expect, test } from "./fixtures/electron-app";
import { unlockTesterAccess } from "./fixtures/tester-access";
import type { Locator, Page } from "@playwright/test";

/**
 * Ledger gates `hotkey-capture-quality` and `readaloud-default-hotkey`.
 *
 * Every assertion here is driven through the real HotkeyInput in the running
 * app, because the failures being guarded against were all failures of the
 * component in situ:
 *
 *  - Pressing Escape to back out of the field used to bind Escape as the global
 *    dictation hotkey, taking the desktop's cancel key away from every app.
 *  - Nothing stopped two features from claiming the same combination; the OS
 *    does not report that, one registration just silently wins.
 *  - The Read Aloud default was Ctrl+Alt+R, which Firefox uses for Reader Mode
 *    and which is AltGr territory on European layouts.
 *
 * The migration cases reload the window rather than calling the migration
 * directly: it runs once at renderer startup, before React mounts, and running
 * at the wrong moment is exactly how a migration gets overwritten by the
 * defaults it was supposed to replace.
 */

/** Sit the app on a known dictation hotkey, then reload so the UI reads it. */
async function seedHotkeys(
  page: Page,
  values: Record<"dictationKey" | "readAloudHotkey", string>
): Promise<void> {
  await page.evaluate((entries) => {
    for (const [key, value] of Object.entries(entries)) localStorage.setItem(key, value);
  }, values);
  await page.reload({ waitUntil: "domcontentloaded" });
}

/**
 * Reach a tester-only page. Unlocked, it sits in the sidebar; locked, it is
 * not listed there and the route runs through the Pro tab's feature card.
 */
async function openFeaturePage(page: Page, name: string) {
  const entry = page.getByRole("button", { name, exact: true });
  if ((await entry.count()) > 0) {
    await entry.click();
  } else {
    await page.getByRole("button", { name: "Early access features", exact: true }).click();
    await page.getByRole("button", { name: new RegExp(`^${name}`) }).click();
  }
  await expect(page.getByRole("heading", { name }).first()).toBeVisible();
}

/** Open the Dictation page and focus the hotkey field. */
async function focusDictationHotkey(page: Page) {
  await page.getByRole("button", { name: "Dictation", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Dictation", exact: true })).toBeVisible();

  const field = page.getByRole("button", { name: "Dictation hotkey" });
  await field.click();
  await expect(field).toContainText("Recording");
  return field;
}

const storedHotkey = (page: Page, key: string) =>
  page.evaluate((name) => localStorage.getItem(name), key);

const EVIDENCE_DIR = path.resolve(__dirname, "..", "..", "docs", "goal-evidence");

/**
 * Shoot the field itself rather than the page: these states are a few lines of
 * text inside one control, and a full-page screenshot renders them too small
 * for anyone to judge the copy.
 */
async function captureField(field: Locator, fileName: string) {
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  const filePath = path.join(EVIDENCE_DIR, fileName);
  await field.screenshot({ path: filePath });

  const bytes = fs.statSync(filePath).size;
  expect(bytes, `${fileName} is too small to show anything (${bytes} bytes)`).toBeGreaterThan(
    1_000
  );
}

test.describe("hotkey capture", () => {
  test("Escape cancels capture instead of being captured", async ({ controlPanel }) => {
    await seedHotkeys(controlPanel, {
      dictationKey: "CommandOrControl+Space",
      readAloudHotkey: "F8",
    });

    const field = await focusDictationHotkey(controlPanel);
    // The listening state now states its own way out, which is the only place
    // a user could learn that Escape is safe to press here.
    await expect(field).toContainText("Esc cancels");
    await captureField(field, "hotkey-capture-listening.png");

    await controlPanel.keyboard.press("Escape");

    // Capture ended...
    await expect(field).not.toContainText("Recording");
    // ...without Escape becoming the hotkey, in the UI or in storage.
    await expect(field).not.toContainText("Esc");
    await expect(field).toContainText("Ctrl");
    await expect(field).toContainText("Space");
    expect(await storedHotkey(controlPanel, "dictationKey")).toBe("CommandOrControl+Space");
  });

  test("a modifier tapped on its own does not commit", async ({ controlPanel }) => {
    await seedHotkeys(controlPanel, {
      dictationKey: "CommandOrControl+Space",
      readAloudHotkey: "F8",
    });

    const field = await focusDictationHotkey(controlPanel);

    // Down and straight back up: no base key, and one modifier is below the
    // two the modifier-only combo path requires.
    await controlPanel.keyboard.down("Control");
    await controlPanel.keyboard.up("Control");

    // Still listening, and nothing was written.
    await expect(field).toContainText("Recording");
    expect(await storedHotkey(controlPanel, "dictationKey")).toBe("CommandOrControl+Space");
  });

  test("Backspace resets the field to the platform default", async ({ controlPanel }) => {
    await seedHotkeys(controlPanel, { dictationKey: "F9", readAloudHotkey: "F8" });

    const field = await focusDictationHotkey(controlPanel);
    await controlPanel.keyboard.press("Backspace");

    await expect(field).not.toContainText("Recording");
    // Backspace is never itself a hotkey.
    await expect(field).not.toContainText("Backspace");
    await expect
      .poll(() => storedHotkey(controlPanel, "dictationKey"))
      .toBe("CommandOrControl+Space");
  });

  test("a key another feature already owns is refused by name", async ({ controlPanel }) => {
    await seedHotkeys(controlPanel, {
      dictationKey: "CommandOrControl+Space",
      readAloudHotkey: "Ctrl+Alt+Shift+R",
    });

    const field = await focusDictationHotkey(controlPanel);
    await controlPanel.keyboard.press("Control+Alt+Shift+R");

    // The refusal names the feature that has it, and the field keeps listening
    // so the next press is the correction.
    await expect(controlPanel.getByTestId("hotkey-conflict")).toHaveText(
      "Already used by Read Aloud"
    );
    await expect(field).toContainText("Recording");
    expect(await storedHotkey(controlPanel, "dictationKey")).toBe("CommandOrControl+Space");

    await captureField(field, "hotkey-capture-conflict.png");

    // A different key is accepted, and the refusal goes with it.
    await controlPanel.keyboard.press("Control+Shift+F10");
    await expect(controlPanel.getByTestId("hotkey-conflict")).toHaveCount(0);
    await expect
      .poll(() => storedHotkey(controlPanel, "dictationKey"))
      .toBe("CommandOrControl+Shift+F10");
  });
});

test.describe("read aloud default hotkey", () => {
  test("a fresh install gets Shift+R", async ({ controlPanel }) => {
    // Read Aloud is where the setting is owned, and mounting the page is what
    // makes useSettings persist its default.
    await openFeaturePage(controlPanel, "Read Aloud");

    await expect.poll(() => storedHotkey(controlPanel, "readAloudHotkey")).toBe("Shift+R");
  });

  test("the old default is migrated, a chosen key is left alone", async ({ controlPanel }) => {
    await openFeaturePage(controlPanel, "Read Aloud");

    await controlPanel.evaluate(() => localStorage.setItem("readAloudHotkey", "Ctrl+Alt+R"));
    await controlPanel.reload({ waitUntil: "domcontentloaded" });
    await expect.poll(() => storedHotkey(controlPanel, "readAloudHotkey")).toBe("Shift+R");

    // Idempotent: a second startup does not keep rewriting it.
    await controlPanel.reload({ waitUntil: "domcontentloaded" });
    expect(await storedHotkey(controlPanel, "readAloudHotkey")).toBe("Shift+R");

    // Anything the user actually picked survives untouched.
    await controlPanel.evaluate(() => localStorage.setItem("readAloudHotkey", "F9"));
    await controlPanel.reload({ waitUntil: "domcontentloaded" });
    expect(await storedHotkey(controlPanel, "readAloudHotkey")).toBe("F9");
  });

  test.describe("with the voice model installed", () => {
    test.use({ seedKokoroModel: true });

    test("renders the new default and refuses the dictation hotkey", async ({ controlPanel }) => {
      // Real activation plus a cold model status read.
      test.setTimeout(120_000);

      // A conflict entry with no hotkey is skipped, and dictationKey ships
      // empty, so the key it has to collide with is set first. Seeding before
      // the unlock keeps the reload away from the cached entitlement.
      await seedHotkeys(controlPanel, {
        dictationKey: "CommandOrControl+Space",
        readAloudHotkey: "Ctrl+Alt+Shift+R",
      });

      await unlockTesterAccess(controlPanel);
      await openFeaturePage(controlPanel, "Read Aloud");

      // The field is only enabled once the model is on disk, which is the only
      // state where the default is visible to a user at all.
      const field = controlPanel.getByRole("button", { name: "Read Aloud hotkey" });
      await expect(field).toContainText("Ctrl");
      await expect(field).toContainText("Alt");
      await expect(field).toContainText("Shift");
      await expect(field).toContainText("R");
      await captureField(field, "readaloud-default-hotkey.png");

      await field.click();
      await expect(field).toContainText("Recording");

      // The dictation hotkey defaults to Ctrl+Space on Windows and Linux.
      await controlPanel.keyboard.press("Control+Space");

      await expect(controlPanel.getByTestId("hotkey-conflict")).toHaveText(
        "Already used by Dictation"
      );
      expect(await storedHotkey(controlPanel, "readAloudHotkey")).toBe("Ctrl+Alt+Shift+R");

      await captureField(field, "readaloud-hotkey-conflict.png");
    });
  });
});
