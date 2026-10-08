import fs from "fs";
import path from "path";
import type { ElectronApplication, Page } from "@playwright/test";
import { test, expect } from "./fixtures/electron-app";

/**
 * Parakeet as the local engine on PCs without an NVIDIA CUDA GPU, or with one
 * too small for Whisper Turbo: chosen in setup when the PC passes the hardware
 * and language checks, kept only when the speed test passes, offered once to
 * existing Whisper users.
 *
 * Hardware detection and every Parakeet model handler are faked in the main
 * process, so no run downloads the 487 MB model or depends on this PC.
 */

const OUT = process.env.PT_CAPTURE_DIR || "test-results/capture";
const VIEWPORT = { width: 1232, height: 788 };
const MODEL = "parakeet-tdt-0.6b-v3";

const PASS = { success: true, decodeMs: 220, audioSec: 10, thresholdMs: 1500, passed: true };
const FAIL = { success: true, decodeMs: 2400, audioSec: 10, thresholdMs: 1500, passed: false };

type FakePc = {
  gpuCategory: "non_nvidia_gpu" | "nvidia_cuda" | "cpu_only";
  parakeetHardware: { eligible: boolean; reasons: string[] };
  physicalCores: number;
  /** The detector's Whisper pick; an NVIDIA card's video memory decides it. */
  whisperModel?: string;
  vramMb?: number;
};

const AMD_LAPTOP: FakePc = {
  gpuCategory: "non_nvidia_gpu",
  parakeetHardware: { eligible: true, reasons: [] },
  physicalCores: 6,
};

// Under 6 GB of video memory the detector picks Small, which Parakeet beats.
const SMALL_NVIDIA: FakePc = {
  gpuCategory: "nvidia_cuda",
  parakeetHardware: { eligible: true, reasons: [] },
  physicalCores: 6,
  whisperModel: "small",
  vramMb: 4096,
};

const LARGE_NVIDIA: FakePc = { ...SMALL_NVIDIA, whisperModel: "turbo", vramMb: 8192 };

const WEAK_PC: FakePc = {
  gpuCategory: "cpu_only",
  parakeetHardware: {
    eligible: false,
    reasons: ["Needs a processor with at least 4 cores. This PC has 2."],
  },
  physicalCores: 2,
};

/** Replace the detect-hardware handler with the real result, edited to look like `pc`. */
async function fakeHardware(electronApp: ElectronApplication, page: Page, pc: FakePc) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const real: any = await page.evaluate(() => (window as any).electronAPI.detectHardware());
  const d = real.detection;
  const amd = pc.gpuCategory === "non_nvidia_gpu";
  const nvidia = pc.gpuCategory === "nvidia_cuda";
  const fake = {
    ...real,
    success: true,
    detection: {
      ...d,
      gpu: {
        ...d.gpu,
        available: amd || nvidia,
        vendor: nvidia ? "nvidia" : amd ? "amd" : "unknown",
        model: nvidia ? "NVIDIA GeForce GTX 1650" : amd ? "AMD Radeon Graphics" : "",
        vram: pc.vramMb ?? 0,
        cuda: { ...(d.gpu?.cuda || {}), available: nvidia },
      },
      cpu: {
        ...d.cpu,
        count: pc.physicalCores * 2,
        physicalCores: pc.physicalCores,
        avx2: true,
        model: amd || nvidia ? "AMD Ryzen 5 5500U with Radeon Graphics" : "Intel Celeron N4020",
      },
      memory: { totalBytes: 16 * 1024 ** 3 },
      recommendations: {
        transcriptionProvider: "local",
        localTranscriptionProvider: "whisper",
        whisperModel: pc.whisperModel ?? "base",
        gpuCategory: pc.gpuCategory,
        reasoning: [
          nvidia
            ? "NVIDIA GPU detected - Whisper will run on the GPU"
            : amd
              ? "AMD GPU detected - Whisper will run on CPU (GPU acceleration currently requires NVIDIA CUDA)"
              : "No dedicated GPU detected - Whisper will run on CPU",
          "Whisper Base keeps transcription quick without a GPU.",
        ],
        recoverySteps: [],
        parakeetHardware: pc.parakeetHardware,
      },
    },
  };
  await electronApp.evaluate(({ ipcMain }, result) => {
    ipcMain.removeHandler("detect-hardware");
    ipcMain.handle("detect-hardware", async () => result);
  }, fake);
}

/** Fake the Parakeet model on disk, its download and its speed test. */
async function stubParakeet(
  electronApp: ElectronApplication,
  speedTest: typeof PASS | typeof FAIL,
  { downloaded = false }: { downloaded?: boolean } = {}
) {
  await electronApp.evaluate(
    ({ ipcMain }, cfg) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const stub = { downloaded: cfg.downloaded, downloads: 0, deletes: 0, speedTests: 0 };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).__parakeetStub = stub;
      const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
      for (const channel of [
        "check-parakeet-model-status",
        "download-parakeet-model",
        "delete-parakeet-model",
        "cancel-parakeet-download",
        "parakeet-speed-test",
      ]) {
        ipcMain.removeHandler(channel);
      }
      ipcMain.handle("check-parakeet-model-status", async () => ({
        success: true,
        model: cfg.model,
        downloaded: stub.downloaded,
      }));
      ipcMain.handle("download-parakeet-model", async (event) => {
        stub.downloads += 1;
        const total = 487 * 1024 * 1024;
        for (const pct of [20, 55, 90]) {
          event.sender.send("parakeet-download-progress", {
            type: "progress",
            model: cfg.model,
            percentage: pct,
            downloaded_bytes: Math.round((total * pct) / 100),
            total_bytes: total,
          });
          await wait(250);
        }
        stub.downloaded = true;
        return { success: true, model: cfg.model, downloaded: true };
      });
      ipcMain.handle("delete-parakeet-model", async () => {
        stub.deletes += 1;
        stub.downloaded = false;
        return { success: true, model: cfg.model, deleted: true, freed_mb: 640 };
      });
      ipcMain.handle("cancel-parakeet-download", async () => ({ success: true }));
      ipcMain.handle("parakeet-speed-test", async () => {
        stub.speedTests += 1;
        // Long enough for the spec to see and capture the testing state.
        await wait(1500);
        return cfg.speedTest;
      });
    },
    { model: MODEL, speedTest, downloaded }
  );
}

async function stubState(electronApp: ElectronApplication) {
  return electronApp.evaluate(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    () =>
      (globalThis as any).__parakeetStub as {
        downloads: number;
        deletes: number;
        speedTests: number;
      }
  );
}

async function shoot(page: Page, name: string) {
  fs.mkdirSync(OUT, { recursive: true });
  await page.mouse.move(VIEWPORT.width - 8, VIEWPORT.height - 8);
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(OUT, `${name}.png`), animations: "disabled" });
}

const stored = (page: Page, key: string) => page.evaluate((k) => localStorage.getItem(k), key);

/** Hardware step first, as a new user sees it, then on to Setup. */
async function openSetupThroughHardware(page: Page, spokenLanguages: string[]) {
  await page.evaluate((langs) => {
    localStorage.removeItem("onboardingCompleted");
    localStorage.setItem("onboardingCurrentStep", "1");
    localStorage.setItem("spokenLanguages", JSON.stringify(langs));
  }, spokenLanguages);
  await page.reload({ waitUntil: "domcontentloaded" });
  const next = page.getByRole("button", { name: "Next", exact: true });
  await expect(next).toBeEnabled({ timeout: 30_000 });
  await next.click();
  await expect(page.getByTestId("onboarding-language")).toBeVisible();
}

test.describe("Parakeet in setup", () => {
  test.use({ completeOnboarding: false });

  test("a qualifying AMD laptop gets Parakeet and keeps it after the speed test", async ({
    controlPanel: page,
    electronApp,
  }) => {
    await page.setViewportSize(VIEWPORT);
    await fakeHardware(electronApp, page, AMD_LAPTOP);
    await stubParakeet(electronApp, PASS);
    await openSetupThroughHardware(page, ["da", "en"]);

    await expect(page.getByTestId("engine-parakeet")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("parakeet-reason")).toHaveText(
      "Parakeet is the fastest engine for this PC."
    );
    await expect.poll(() => stored(page, "localTranscriptionProvider")).toBe("nvidia");
    const next = page.getByRole("button", { name: "Next", exact: true });
    await expect(next).toBeDisabled();
    await page.getByTestId("parakeet-panel").scrollIntoViewIfNeeded();
    await shoot(page, "after-1-setup-parakeet-picked");

    await page.getByTestId("parakeet-panel").getByRole("button", { name: "Download" }).click();
    await expect(page.getByText("Downloading Parakeet")).toBeVisible();
    await shoot(page, "after-2-setup-parakeet-downloading");

    await expect(page.getByTestId("parakeet-speed")).toHaveText("Testing speed on this PC", {
      timeout: 15_000,
    });
    await expect(next).toBeDisabled();
    await shoot(page, "after-3-setup-parakeet-testing");

    await expect(page.getByTestId("parakeet-speed")).toHaveText(
      "10 s of speech in 0.2 s on this PC",
      { timeout: 15_000 }
    );
    await expect(next).toBeEnabled();
    expect(await stored(page, "localTranscriptionProvider")).toBe("nvidia");
    expect(await stored(page, "parakeetEngineV2")).toBe("1");
    expect(await stubState(electronApp)).toMatchObject({ downloads: 1, speedTests: 1, deletes: 0 });
    await shoot(page, "after-4-setup-parakeet-passed");
  });

  test("a failed speed test deletes the model and falls back to Whisper", async ({
    controlPanel: page,
    electronApp,
  }) => {
    await page.setViewportSize(VIEWPORT);
    await fakeHardware(electronApp, page, AMD_LAPTOP);
    await stubParakeet(electronApp, FAIL);
    await openSetupThroughHardware(page, ["en"]);

    await expect(page.getByTestId("engine-parakeet")).toHaveAttribute("aria-pressed", "true");
    await page.getByTestId("parakeet-panel").getByRole("button", { name: "Download" }).click();

    await expect(page.getByTestId("parakeet-fallback")).toHaveText(
      "Your PC is better suited to Whisper.",
      { timeout: 15_000 }
    );
    await expect(page.getByTestId("engine-whisper")).toHaveAttribute("aria-pressed", "true");
    expect(await stored(page, "localTranscriptionProvider")).toBe("whisper");
    expect(await stored(page, "whisperModel")).toBe("base");
    expect(await stubState(electronApp)).toMatchObject({ downloads: 1, speedTests: 1, deletes: 1 });
    // Setup must not pick Parakeet again on its own after the test said no.
    await page.waitForTimeout(500);
    await expect(page.getByTestId("engine-whisper")).toHaveAttribute("aria-pressed", "true");
    await page.getByTestId("parakeet-fallback").scrollIntoViewIfNeeded();
    await shoot(page, "after-5-setup-speed-test-fallback");
  });

  test("a small NVIDIA card gets Parakeet, since Whisper only fits Small on it", async ({
    controlPanel: page,
    electronApp,
  }) => {
    await page.setViewportSize(VIEWPORT);
    await fakeHardware(electronApp, page, SMALL_NVIDIA);
    await stubParakeet(electronApp, PASS);
    await openSetupThroughHardware(page, ["da", "en"]);

    const parakeet = page.getByTestId("engine-parakeet");
    await expect(parakeet).toHaveAttribute("aria-pressed", "true");
    await expect(parakeet).not.toContainText("faster");
    await expect(page.getByTestId("parakeet-reason")).toHaveText(
      "Parakeet makes fewer mistakes than the Whisper model your graphics card has room for."
    );
    await expect.poll(() => stored(page, "localTranscriptionProvider")).toBe("nvidia");
    await page.getByTestId("parakeet-panel").scrollIntoViewIfNeeded();
    await shoot(page, "after-12-setup-small-nvidia-parakeet");
  });

  test("an NVIDIA card with room for Turbo keeps GPU Whisper", async ({
    controlPanel: page,
    electronApp,
  }) => {
    await page.setViewportSize(VIEWPORT);
    await fakeHardware(electronApp, page, LARGE_NVIDIA);
    await stubParakeet(electronApp, PASS);
    await openSetupThroughHardware(page, ["da", "en"]);

    await expect(page.getByTestId("engine-whisper")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("parakeet-reason")).toHaveCount(0);
    await page.waitForTimeout(500);
    expect(await stored(page, "localTranscriptionProvider")).toBe("whisper");
    await page.getByTestId("engine-whisper").scrollIntoViewIfNeeded();
    await shoot(page, "after-13-setup-large-nvidia-whisper");
  });

  test("an ineligible PC stays on Whisper with no Parakeet push", async ({
    controlPanel: page,
    electronApp,
  }) => {
    await page.setViewportSize(VIEWPORT);
    await fakeHardware(electronApp, page, WEAK_PC);
    await stubParakeet(electronApp, PASS);
    await openSetupThroughHardware(page, ["en"]);

    await expect(page.getByTestId("engine-whisper")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("engine-parakeet")).toBeDisabled();
    await expect(page.getByTestId("parakeet-hardware-reasons")).toContainText(
      "Needs a processor with at least 4 cores. This PC has 2."
    );
    await expect(page.getByTestId("parakeet-reason")).toHaveCount(0);
    await page.waitForTimeout(500);
    expect(await stored(page, "localTranscriptionProvider")).toBe("whisper");
    await page.getByTestId("engine-whisper").scrollIntoViewIfNeeded();
    await shoot(page, "after-6-setup-ineligible-pc");
  });
});

async function openDictationPage(page: Page, settings: Record<string, string>) {
  await page.evaluate((values) => {
    localStorage.setItem("useLocalWhisper", "true");
    localStorage.setItem("whisperModel", "base");
    localStorage.setItem("whisperForceCpu", "true");
    localStorage.setItem("localTranscriptionProvider", "whisper");
    localStorage.setItem("parakeetEngineV2", "1");
    localStorage.removeItem("parakeetOfferDismissed");
    localStorage.removeItem("parakeetSpeedTest");
    for (const [key, value] of Object.entries(values)) localStorage.setItem(key, value);
  }, settings);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Dictation", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Controls", exact: true })).toBeVisible();
}

test.describe("Parakeet in settings", () => {
  test("the one-time card switches an existing Whisper user after a passed test", async ({
    controlPanel: page,
    electronApp,
  }) => {
    await page.setViewportSize(VIEWPORT);
    await fakeHardware(electronApp, page, AMD_LAPTOP);
    await stubParakeet(electronApp, PASS);
    await openDictationPage(page, { spokenLanguages: JSON.stringify(["da"]) });

    const card = page.getByTestId("parakeet-offer");
    await expect(card).toBeVisible({ timeout: 15_000 });
    await card.scrollIntoViewIfNeeded();
    await shoot(page, "after-7-settings-offer-card");

    await card.getByRole("button", { name: "Try Parakeet" }).click();
    await expect(card).toHaveCount(0);
    await expect(page.getByTestId("engine-parakeet")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("parakeet-speed")).toHaveText(
      "10 s of speech in 0.2 s on this PC",
      { timeout: 15_000 }
    );
    expect(await stored(page, "localTranscriptionProvider")).toBe("nvidia");
    await page.getByTestId("parakeet-panel").scrollIntoViewIfNeeded();
    await shoot(page, "after-8-settings-parakeet-in-use");

    // The choice survives a restart: the retired-engine migration must not undo it.
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Dictation", exact: true }).click();
    await expect(page.getByTestId("engine-parakeet")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("parakeet-offer")).toHaveCount(0);
  });

  test("Not now hides the card for good, and the engine can be picked by hand", async ({
    controlPanel: page,
    electronApp,
  }) => {
    await page.setViewportSize(VIEWPORT);
    await fakeHardware(electronApp, page, AMD_LAPTOP);
    await stubParakeet(electronApp, PASS);
    await openDictationPage(page, { spokenLanguages: JSON.stringify(["en"]) });

    const card = page.getByTestId("parakeet-offer");
    await expect(card).toBeVisible({ timeout: 15_000 });
    await card.getByRole("button", { name: "Not now" }).click();
    await expect(card).toHaveCount(0);
    expect(await stored(page, "parakeetOfferDismissed")).toBe("1");

    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Dictation", exact: true }).click();
    await expect(page.getByTestId("engine-whisper")).toHaveAttribute("aria-pressed", "true");
    await page.waitForTimeout(800);
    await expect(page.getByTestId("parakeet-offer")).toHaveCount(0);
    await page.getByTestId("engine-whisper").scrollIntoViewIfNeeded();
    await shoot(page, "after-9-settings-whisper-card-dismissed");

    await page.getByTestId("engine-parakeet").click();
    const panel = page.getByTestId("parakeet-panel");
    await expect(panel).toContainText("487 MB");
    await expect(panel).toContainText("25 European languages");
    await shoot(page, "after-10-settings-parakeet-not-downloaded");

    await panel.getByRole("button", { name: "Download" }).click();
    await expect(page.getByTestId("parakeet-speed")).toHaveText(
      "10 s of speech in 0.2 s on this PC",
      { timeout: 15_000 }
    );

    await page.getByTestId("engine-whisper").click();
    await expect.poll(() => stored(page, "localTranscriptionProvider")).toBe("whisper");
  });

  test("a small NVIDIA card gets its own card copy, and none once on Turbo", async ({
    controlPanel: page,
    electronApp,
  }) => {
    await page.setViewportSize(VIEWPORT);
    await fakeHardware(electronApp, page, SMALL_NVIDIA);
    await stubParakeet(electronApp, PASS);
    await openDictationPage(page, {
      spokenLanguages: JSON.stringify(["da"]),
      whisperModel: "small",
      whisperForceCpu: "false",
    });

    const card = page.getByTestId("parakeet-offer");
    await expect(card).toBeVisible({ timeout: 15_000 });
    await expect(card).toContainText("Your graphics card only has room for a small Whisper model");
    await card.scrollIntoViewIfNeeded();
    await shoot(page, "after-14-settings-small-nvidia-card");

    // Someone who picked Turbo by hand already runs the stronger engine.
    await openDictationPage(page, {
      spokenLanguages: JSON.stringify(["da"]),
      whisperModel: "turbo",
      whisperForceCpu: "false",
    });
    await expect(page.getByTestId("engine-whisper")).toHaveAttribute("aria-pressed", "true");
    await page.waitForTimeout(800);
    await expect(page.getByTestId("parakeet-offer")).toHaveCount(0);
    // The picker agrees with the card: Whisper stays the recommended engine.
    await expect(page.getByTestId("engine-whisper")).toContainText("Recommended");
    await expect(page.getByTestId("engine-parakeet")).not.toContainText("Recommended");
  });

  test("a spoken language outside the 25 gets a plain warning and no card", async ({
    controlPanel: page,
    electronApp,
  }) => {
    await page.setViewportSize(VIEWPORT);
    await fakeHardware(electronApp, page, AMD_LAPTOP);
    await stubParakeet(electronApp, PASS);
    await openDictationPage(page, { spokenLanguages: JSON.stringify(["da", "ja"]) });

    const warning = page.getByTestId("parakeet-language-warning");
    await expect(warning).toHaveText("Parakeet does not support Japanese. Whisper does.");
    await expect(page.getByTestId("parakeet-offer")).toHaveCount(0);
    await warning.scrollIntoViewIfNeeded();
    await shoot(page, "after-11-settings-language-warning");
  });

  test("a value stored by the retired engine reads as Whisper", async ({ controlPanel: page }) => {
    await page.evaluate(() => {
      localStorage.setItem("useLocalWhisper", "true");
      localStorage.setItem("localTranscriptionProvider", "nvidia");
      localStorage.removeItem("parakeetEngineV2");
    });
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect.poll(() => stored(page, "localTranscriptionProvider")).toBe("whisper");
    expect(await stored(page, "parakeetEngineV2")).toBe("1");
  });
});
