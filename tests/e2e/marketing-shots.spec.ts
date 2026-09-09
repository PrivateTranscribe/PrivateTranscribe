import fs from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "./fixtures/electron-app";
import { seedShowcaseDatabase } from "./fixtures/showcase-data";
import { unlockTesterAccess } from "./fixtures/tester-access";

/**
 * Captures the gallery images for the AlternativeTo listing.
 *
 * Not a test. It asserts only enough to know a page really rendered before the
 * shutter, and it is skipped unless PT_MARKETING_SHOTS is set, so an ordinary
 * `npm run test:e2e` neither runs it nor writes images.
 *
 *   PT_MARKETING_SHOTS=1 npx playwright test marketing-shots
 *
 * The home directory is deliberately NOT thrown away: the app then finds the
 * machine's real Whisper models and CUDA engine, so the setup panel shows the
 * engine this PC actually has rather than an unconfigured one. Only userData
 * (database and settings) is a throwaway, so nothing here touches real history.
 */
const SHOTS_DIR = process.env.PT_SHOTS_DIR ?? path.resolve("test-results/marketing-shots");

// Matches the 1.56 aspect of the images already on the listing, so replacements
// sit in the gallery at the same shape.
const VIEWPORT = { width: 1232, height: 788 };

// Link the machine's installed CUDA package into the throwaway profile, so the
// setup panel reports the GPU engine this PC really has rather than the CPU
// fallback an empty profile always shows.
test.use({ seedCudaEngine: true });

test.skip(
  !process.env.PT_MARKETING_SHOTS,
  "Marketing capture run. Set PT_MARKETING_SHOTS=1 to enable."
);

async function shoot(page: Page, name: string) {
  fs.mkdirSync(SHOTS_DIR, { recursive: true });
  // Park the pointer off the content so nothing sits in a hover state, and drop
  // any text selection a previous click left highlighted mid-sentence.
  await page.mouse.move(VIEWPORT.width - 8, VIEWPORT.height - 8);
  await page.evaluate(() => window.getSelection()?.removeAllRanges());
  await page.screenshot({ path: path.join(SHOTS_DIR, `${name}.png`), animations: "disabled" });
}

test("capture the listing gallery", async ({ controlPanel: page, electronApp }) => {
  test.setTimeout(180_000);
  await page.setViewportSize(VIEWPORT);

  await page.evaluate(() => {
    // The setup panel on the dashboard reads these four.
    localStorage.setItem("useLocalWhisper", "true");
    localStorage.setItem("whisperModel", "turbo");
    localStorage.setItem("whisperForceCpu", "false");
    localStorage.setItem("preferredLanguage", "auto");
    localStorage.setItem("preferBuiltInMic", "true");
    // A throwaway profile has no hotkey, so the Dictation page would show an
    // empty "Click to set hotkey" slot instead of the product's actual default.
    localStorage.setItem("dictationKey", "`");
    localStorage.setItem("readAloudEnabled", "true");
    // Sample recents, so Converse shows its project list rather than an empty
    // page. Deliberately paths that do not exist on this machine: a real one
    // would put the developer's own home directory into a public screenshot.
    localStorage.setItem(
      "converseProjects",
      JSON.stringify([
        { path: "C:\\Projects\\acme-web", lastUsedAt: Date.now() - 3_600_000 },
        { path: "C:\\Projects\\billing-service", lastUsedAt: Date.now() - 86_400_000 },
      ])
    );
  });

  await seedShowcaseDatabase(electronApp);
  await page.reload();

  // Unlock before the first capture, not between them: Read Aloud, AI
  // Enhancement and Action Engine collapse into a single locked "Beta features"
  // row until this runs, and the sidebar is in every shot.
  await unlockTesterAccess(page);

  // The microphone label prints whatever device the OS reports, which on a
  // developer machine is their own headset by name. Reporting no labelled
  // inputs is the state a machine that has not granted microphone permission is
  // in, and it renders the generic "Built-in preferred" instead.
  await page.evaluate(() => {
    navigator.mediaDevices.enumerateDevices = async () => [];
  });

  await page.getByRole("button", { name: "Home", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
  // Tolerant of the thousands separator the renderer's locale picks.
  await expect(page.getByText(/34[.,\s]892/)).toBeVisible();
  await expect(page.getByText("7 days")).toBeVisible();
  await shoot(page, "1-dashboard");

  await page.getByRole("button", { name: "History", exact: true }).click();
  await expect(page.getByRole("heading", { name: "History" })).toBeVisible();
  await expect(page.getByText(/Review the authentication flow/)).toBeVisible();
  await shoot(page, "2-history");

  await page.getByRole("button", { name: "Dictation", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Controls", exact: true })).toBeVisible();
  // The GPU tile starts disabled and enables when detectHardware() comes back,
  // which is slower than the heading. Without this wait the shot catches the
  // pre-detection state and contradicts the dashboard's "GPU, ready".
  await expect(page.getByText("Needs NVIDIA GPU")).toHaveCount(0, { timeout: 30_000 });
  await shoot(page, "3-dictation");

  await page.getByRole("button", { name: "Read Aloud", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Read Aloud" })).toBeVisible();
  await shoot(page, "4-read-aloud");

  await page.getByRole("button", { name: "Converse", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Converse", exact: true })).toBeVisible();
  await shoot(page, "5-converse");

  console.log(`[shots] wrote 5 images to ${SHOTS_DIR}`);
});
