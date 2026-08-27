import fs from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures/electron-app";

const EVIDENCE_DIR = path.resolve(__dirname, "..", "..", "docs", "goal-evidence");

/**
 * Clip a region around the language selector (its popup is absolutely
 * positioned, so an element screenshot of the trigger would cut it off).
 */
async function captureSelectorRegion(page: Page, fileName: string, height: number): Promise<void> {
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  const box = await languageTrigger(page).boundingBox();
  if (!box) throw new Error("language selector has no bounding box");
  const filePath = path.join(EVIDENCE_DIR, fileName);
  await page.screenshot({
    path: filePath,
    clip: { x: Math.max(0, box.x - 24), y: Math.max(0, box.y - 40), width: box.width + 48, height },
  });
  const bytes = fs.statSync(filePath).size;
  expect(bytes, `${fileName} is too small to show anything (${bytes} bytes)`).toBeGreaterThan(
    1_000
  );
}

/**
 * Ledger gate `transcribe-language-settings-link`.
 *
 * The Transcribe page's language default used to be a bare "auto" no matter
 * what the user told Settings they speak. It now derives from the spoken-
 * language set: one language means decode straight to it, several mean
 * auto-detect narrowed to that shortlist (with the shortlist hoisted to the
 * top of the picker, so it is not buried under fifty alphabetical entries).
 * A choice made on this page's own selector — including choosing
 * Auto-detect explicitly — always wins over the derivation, and never
 * rewrites Settings' spoken languages or the dictation `preferredLanguage`.
 *
 * No transcription runs here: this is entirely about the selector's default
 * and persistence, so there is no model seeding, no audio, and no mic.
 */

async function seedAndReload(page: Page, values: Record<string, string>): Promise<void> {
  await page.evaluate((entries) => {
    for (const [key, value] of Object.entries(entries)) localStorage.setItem(key, value);
  }, values);
  await page.reload({ waitUntil: "domcontentloaded" });
}

async function openTranscribePage(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Transcribe File", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Transcribe", exact: true })).toBeVisible();
}

/** The shared LanguageSelector's trigger — the only listbox button on this page. */
const languageTrigger = (page: Page) => page.locator('button[aria-haspopup="listbox"]').first();

async function selectLanguage(page: Page, label: string): Promise<void> {
  await languageTrigger(page).click();
  await page.getByPlaceholder("Search...").fill(label);
  await page.getByRole("option", { name: label, exact: true }).click();
  await expect(languageTrigger(page)).toHaveText(label);
}

const storedValue = (page: Page, key: string) =>
  page.evaluate((name) => localStorage.getItem(name), key);

test.describe("Transcribe page language default", () => {
  test("a single spoken language becomes the file default", async ({ controlPanel }) => {
    await seedAndReload(controlPanel, { spokenLanguages: JSON.stringify(["da"]) });
    await openTranscribePage(controlPanel);

    await expect(languageTrigger(controlPanel)).toHaveText("Danish");
    // The page never had a chance to write its own override for this to hold.
    expect(await storedValue(controlPanel, "fileTranscriptionLanguage")).toBeNull();

    await captureSelectorRegion(controlPanel, "transcribe-language-derived-default.png", 120);
  });

  test("multiple spoken languages default to auto, hoisted to the top of the selector", async ({
    controlPanel,
  }) => {
    await seedAndReload(controlPanel, { spokenLanguages: JSON.stringify(["da", "en"]) });
    await openTranscribePage(controlPanel);

    await expect(languageTrigger(controlPanel)).toHaveText("Auto-detect");

    await languageTrigger(controlPanel).click();
    const options = controlPanel.getByRole("option");
    // The picker still lists all 58 options — only the order changed.
    await expect(options).toHaveCount(58);
    await expect(options.nth(0)).toHaveText("Auto-detect");
    await expect(options.nth(1)).toHaveText("Danish");
    await expect(options.nth(2)).toHaveText("English");

    await captureSelectorRegion(controlPanel, "transcribe-language-hoisted.png", 400);
  });

  test("a stored auto is a deliberate choice and still beats a single spoken language", async ({
    controlPanel,
  }) => {
    await seedAndReload(controlPanel, {
      spokenLanguages: JSON.stringify(["da"]),
      fileTranscriptionLanguage: "auto",
    });
    await openTranscribePage(controlPanel);

    await expect(languageTrigger(controlPanel)).toHaveText("Auto-detect");
  });

  test("an override on this page survives independently of Settings, across a reload", async ({
    controlPanel,
  }) => {
    await seedAndReload(controlPanel, { spokenLanguages: JSON.stringify(["da", "en"]) });
    await openTranscribePage(controlPanel);

    const before = await controlPanel.evaluate(() => ({
      spokenLanguages: localStorage.getItem("spokenLanguages"),
      preferredLanguage: localStorage.getItem("preferredLanguage"),
    }));

    await selectLanguage(controlPanel, "Swedish");

    const after = await controlPanel.evaluate(() => ({
      fileTranscriptionLanguage: localStorage.getItem("fileTranscriptionLanguage"),
      spokenLanguages: localStorage.getItem("spokenLanguages"),
      preferredLanguage: localStorage.getItem("preferredLanguage"),
    }));

    // The override landed...
    expect(after.fileTranscriptionLanguage).toBe("sv");
    // ...and nothing Settings owns moved, whatever it held before the pick.
    expect(after.spokenLanguages).toBe(before.spokenLanguages);
    expect(after.preferredLanguage).toBe(before.preferredLanguage);

    await controlPanel.reload({ waitUntil: "domcontentloaded" });
    await openTranscribePage(controlPanel);
    await expect(languageTrigger(controlPanel)).toHaveText("Swedish");
  });

  test("the default keeps following Settings until the user overrides it here", async ({
    controlPanel,
  }) => {
    await seedAndReload(controlPanel, { spokenLanguages: JSON.stringify(["da"]) });
    await openTranscribePage(controlPanel);
    await expect(languageTrigger(controlPanel)).toHaveText("Danish");

    // Settings gains a second spoken language while this page was never
    // touched — reload stands in for "navigate away and back", which is how
    // a real settings edit reaches an already-open Transcribe page.
    await controlPanel.evaluate(() =>
      localStorage.setItem("spokenLanguages", JSON.stringify(["da", "en"]))
    );
    await controlPanel.reload({ waitUntil: "domcontentloaded" });
    await openTranscribePage(controlPanel);

    await expect(languageTrigger(controlPanel)).toHaveText("Auto-detect");
  });
});
