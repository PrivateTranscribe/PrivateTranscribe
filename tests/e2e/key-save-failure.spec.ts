import fs from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures/electron-app";
import { unlockTesterAccess } from "./fixtures/tester-access";

/**
 * A key that could not be written to keys.enc says so. Saving used to report
 * success whatever happened to the file, so the key worked until the app
 * closed and was then gone with no clue why.
 *
 * keys.enc is made read-only after the app has started, so its write fails the
 * way a locked or full disk would.
 */

test.use({ appEnv: { PRIVATETRANSCRIBE_DIAG_DISABLE_OVERLAY_WINDOW: "1" } });

const UNSAVED_KEY = "sk-e2e-made-up-unsaved";
// Set PT_PROOF_DIR to keep the screenshot for a pull request.
const proofDir = process.env.PT_PROOF_DIR;

/** AI Enhancement with OpenAI cleanup chosen and no key yet, so the key field shows. */
async function openOpenAIKeyField(page: Page) {
  await unlockTesterAccess(page);
  await page.evaluate(() => {
    localStorage.setItem("useReasoningModel", "true");
    localStorage.setItem("reasoningModel", "gpt-5.6-luna");
    localStorage.removeItem("openaiApiKey");
  });
  await page.getByRole("button", { name: "AI Enhancement", exact: true }).click();
  await expect(page.getByText("API key needed", { exact: true })).toBeVisible();
  return page.getByLabel("OpenAI API key");
}

test("a key typed one keystroke at a time saves without a notice", async ({
  controlPanel: page,
  userDataDir,
}) => {
  const storePath = path.join(userDataDir, "keys.enc");
  const writtenBefore = fs.existsSync(storePath) ? fs.statSync(storePath).mtimeMs : 0;
  const field = await openOpenAIKeyField(page);

  await field.pressSequentially("sk-e2e-made-up-saved");

  await expect
    .poll(() => (fs.existsSync(storePath) ? fs.statSync(storePath).mtimeMs : 0))
    .toBeGreaterThan(writtenBefore);
  expect(await page.evaluate(() => window.electronAPI.getOpenAIKey())).toBe("sk-e2e-made-up-saved");
  await page.waitForTimeout(500);
  await expect(page.getByText("Could not save the key", { exact: true })).toHaveCount(0);
  await expect(page.getByText("API key saved", { exact: true })).toBeVisible();
});

test("a key that cannot be written shows a notice and still works until the app closes", async ({
  controlPanel: page,
  electronApp,
  userDataDir,
}) => {
  const storePath = path.join(userDataDir, "keys.enc");
  const emptyStore = await electronApp.evaluate(async ({ safeStorage }) =>
    (await safeStorage.encryptStringAsync("{}")).toString("base64")
  );
  fs.writeFileSync(storePath, Buffer.from(emptyStore, "base64"));
  fs.chmodSync(storePath, 0o444);

  try {
    const field = await openOpenAIKeyField(page);

    await field.fill(UNSAVED_KEY);

    const notice = page.getByText("Could not save the key", { exact: true });
    await notice.waitFor({ state: "visible", timeout: 5000 }).catch(() => {});
    if (proofDir) {
      fs.mkdirSync(proofDir, { recursive: true });
      await page.screenshot({
        path: path.join(proofDir, "key-save-failure.png"),
        animations: "disabled",
      });
    }
    await expect(notice).toBeVisible();
    await expect(
      page.getByText("It works until you close the app.", { exact: true })
    ).toBeVisible();
    expect(await page.evaluate(() => window.electronAPI.getOpenAIKey())).toBe(UNSAVED_KEY);
    // The card says so too, and never claims the key is saved.
    await expect(page.getByText("API key not saved", { exact: true })).toBeVisible();
    await expect(page.getByText("API key saved", { exact: true })).toHaveCount(0);

    // Once the disk takes the write, the next keystroke saves it and the card says so.
    fs.chmodSync(storePath, 0o666);
    await field.press("End");
    await field.pressSequentially("x");
    await expect(page.getByText("API key saved", { exact: true })).toBeVisible();
    await expect(page.getByText("API key not saved", { exact: true })).toHaveCount(0);
  } finally {
    fs.chmodSync(storePath, 0o666);
  }
});
