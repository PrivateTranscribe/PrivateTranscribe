import fs from "fs";
import path from "path";
import type { ElectronApplication, Page } from "@playwright/test";
import { test, expect } from "./fixtures/electron-app";

/**
 * The first run, as a new user meets it.
 *
 * On 9 Nov 2026 a first-time user finished setup without the GPU engine (the
 * download was an optional button under the fold, and Next worked without
 * it), so Whisper Large ran on the processor. He also used the microphone
 * before pressing Allow: the mic test worked, and so did the dictation key,
 * because nothing in the main process asked.
 *
 * Hardware detection, model downloads, the GPU engine download and the GPU
 * test run are faked in the main process, so no spec downloads gigabytes or
 * depends on this PC's graphics card. The microphone is Chromium's fake
 * capture device playing a WAV, never the real one.
 */

const OUT = process.env.PT_CAPTURE_DIR || "test-results/first-run";
const VIEWPORT = { width: 1232, height: 788 };
const FAKE_WAV = path.resolve(__dirname, "..", "fixtures", "dictation", "banana.wav");

/**
 * Chromium's fake capture device playing a WAV, without the fixture's
 * --use-fake-ui-for-media-stream. That flag accepts every request before
 * Electron's permission handler is asked, so with it the gate under test
 * would never run.
 */
const FAKE_MIC_ARGS = [
  "--use-fake-device-for-media-stream",
  `--use-file-for-fake-audio-capture=${FAKE_WAV}`,
];

async function shot(page: Page, name: string) {
  fs.mkdirSync(OUT, { recursive: true });
  await page.setViewportSize(VIEWPORT);
  await page.screenshot({ path: path.join(OUT, `${name}.png`) });
}

const next = (page: Page) => page.getByRole("button", { name: "Next" });

type FakePc = {
  gpuCategory: "nvidia_cuda" | "non_nvidia_gpu" | "cpu_only";
  gpuName: string;
  vramMb: number;
  /** The detector's own pick for this PC. */
  whisperModel: string;
  threads: number;
};

const RTX_3090: FakePc = {
  gpuCategory: "nvidia_cuda",
  gpuName: "NVIDIA GeForce RTX 3090",
  vramMb: 24576,
  whisperModel: "large",
  threads: 32,
};

const AMD_LAPTOP: FakePc = {
  gpuCategory: "non_nvidia_gpu",
  gpuName: "AMD Radeon(TM) Graphics",
  vramMb: 2048,
  whisperModel: "base",
  threads: 8,
};

/** Replace detect-hardware with the real result edited to look like `pc`. */
async function fakeHardware(app: ElectronApplication, page: Page, pc: FakePc) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const real: any = await page.evaluate(() => (window as any).electronAPI.detectHardware());
  const d = real.detection;
  const nvidia = pc.gpuCategory === "nvidia_cuda";
  const fake = {
    ...real,
    success: true,
    detection: {
      ...d,
      gpu: {
        ...d.gpu,
        available: true,
        vendor: nvidia ? "nvidia" : "amd",
        model: pc.gpuName,
        vram: pc.vramMb,
        cuda: { ...(d.gpu?.cuda || {}), available: nvidia },
      },
      cpu: { ...d.cpu, count: pc.threads, physicalCores: pc.threads / 2, avx2: true },
      recommendations: {
        transcriptionProvider: "local",
        localTranscriptionProvider: "whisper",
        whisperModel: pc.whisperModel,
        gpuCategory: pc.gpuCategory,
        reasoning: [
          nvidia ? "NVIDIA graphics card." : "AMD GPU detected - Whisper will run on CPU",
        ],
        recoverySteps: [],
        // Kept out of these specs: Parakeet has its own (parakeet-setup.spec.ts).
        parakeetHardware: { eligible: false, reasons: [] },
      },
    },
  };
  await app.evaluate(({ ipcMain }, result) => {
    ipcMain.removeHandler("detect-hardware");
    ipcMain.handle("detect-hardware", async () => result);
  }, fake);
}

type StubConfig = {
  /** What the GPU engine download returns. */
  engineResult: { success: boolean; error?: string };
  /** What Whisper reports it ran on once started. */
  serverEngine: "cuda" | "cpu";
  diagnostic?: { kind: string; message: string } | null;
  modelsOnDisk?: string[];
};

type StubState = {
  modelDownloads: string[];
  engineDownloads: number;
  engineInstalled: boolean;
  serverStarts: string[];
  cfg: StubConfig;
};

/** Fake the model files, the engine download and the GPU test run. */
async function stubDownloads(app: ElectronApplication, page: Page, cfg: StubConfig) {
  const realList = await page.evaluate(() =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).electronAPI.listWhisperModels()
  );
  await app.evaluate(
    ({ ipcMain }, { cfg, realList }) => {
      const g = globalThis as unknown as { __setupStub: StubState };
      const onDisk = new Set(cfg.modelsOnDisk ?? []);
      const state: StubState = {
        modelDownloads: [],
        engineDownloads: 0,
        engineInstalled: false,
        serverStarts: [],
        cfg,
      };
      g.__setupStub = state;
      const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
      for (const channel of [
        "check-model-status",
        "list-whisper-models",
        "download-whisper-model",
        "download-cuda-binary",
        "get-cuda-binary-status",
        "whisper-server-start",
      ]) {
        ipcMain.removeHandler(channel);
      }
      ipcMain.handle("check-model-status", async (_e, model: string) => ({
        success: true,
        model,
        downloaded: onDisk.has(model),
      }));
      ipcMain.handle("list-whisper-models", async () => ({
        ...realList,
        models: realList.models.map((m: { model: string }) => ({
          ...m,
          downloaded: onDisk.has(m.model),
        })),
      }));
      ipcMain.handle("download-whisper-model", async (_e, model: string) => {
        state.modelDownloads.push(model);
        await wait(400);
        onDisk.add(model);
        return { success: true, model };
      });
      ipcMain.handle("download-cuda-binary", async () => {
        state.engineDownloads += 1;
        await wait(900);
        if (state.cfg.engineResult.success) state.engineInstalled = true;
        return state.cfg.engineResult;
      });
      ipcMain.handle("get-cuda-binary-status", async () => ({
        installed: state.engineInstalled,
        upToDate: state.engineInstalled,
        supported: true,
        platform: "win32-x64",
        path: state.engineInstalled ? "C:\\fake\\whisper-server-win32-x64-cuda.exe" : null,
        forceCpu: false,
        activeDownload: null,
        engineStatus: {
          effectiveEngine: state.serverStarts.length ? state.cfg.serverEngine : "stopped",
          fallback: {
            active: state.cfg.serverEngine !== "cuda",
            diagnostic: state.cfg.diagnostic ?? null,
          },
        },
      }));
      ipcMain.handle("whisper-server-start", async (_e, model: string) => {
        state.serverStarts.push(model);
        await wait(300);
        return { success: true, port: 1 };
      });
    },
    { cfg, realList }
  );
}

const stubState = (app: ElectronApplication) =>
  app.evaluate(() => (globalThis as unknown as { __setupStub: StubState }).__setupStub);

/** Land on the hardware step with a clean setup and the given languages. */
async function startAtHardware(page: Page, languages: string[]) {
  await page.evaluate((langs) => {
    localStorage.removeItem("onboardingCompleted");
    localStorage.setItem("onboardingCurrentStep", "1");
    localStorage.setItem("spokenLanguages", JSON.stringify(langs));
    localStorage.setItem("preferredLanguage", langs.length === 1 ? langs[0] : "auto");
  }, languages);
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByText("Settings applied")).toBeVisible({ timeout: 30_000 });
  await next(page).click();
  await expect(page.getByText("Transcription Setup")).toBeVisible();
}

const setting = (page: Page, key: string) => page.evaluate((k) => localStorage.getItem(k), key);

test.use({ completeOnboarding: false });

test.describe("GPU engine in setup", () => {
  test("a GPU PC gets the engine with the model and setup waits for both", async ({
    electronApp,
    controlPanel,
  }) => {
    await fakeHardware(electronApp, controlPanel, RTX_3090);
    await stubDownloads(electronApp, controlPanel, {
      engineResult: { success: true },
      serverEngine: "cuda",
    });
    await startAtHardware(controlPanel, ["en"]);

    const card = controlPanel.getByTestId("onboarding-gpu-engine");
    await expect(card).toContainText("downloads together with the model");
    await expect(next(controlPanel)).toBeDisabled();
    expect(await setting(controlPanel, "whisperModel")).toBe("large");
    await shot(controlPanel, "gpu-1-before-download");

    // One click on the model downloads both.
    await controlPanel.getByRole("button", { name: "Download", exact: true }).first().click();
    await expect(card).toContainText("Downloading together with your model");
    await shot(controlPanel, "gpu-2-downloading");

    await expect(controlPanel.getByTestId("gpu-engine-status")).toHaveText(
      "Dictation runs on your NVIDIA GeForce RTX 3090.",
      { timeout: 15_000 }
    );
    await expect(next(controlPanel)).toBeEnabled();
    await card.scrollIntoViewIfNeeded();
    await shot(controlPanel, "gpu-3-ready");

    const state = await stubState(electronApp);
    expect(state.modelDownloads).toEqual(["large"]);
    expect(state.engineDownloads).toBe(1);
    expect(state.serverStarts).toEqual(["large"]);
    expect(await setting(controlPanel, "whisperForceCpu")).toBe("false");
  });

  test("a model already on disk still needs the engine before Next", async ({
    electronApp,
    controlPanel,
  }) => {
    await fakeHardware(electronApp, controlPanel, RTX_3090);
    await stubDownloads(electronApp, controlPanel, {
      engineResult: { success: true },
      serverEngine: "cuda",
      modelsOnDisk: ["large"],
    });
    await startAtHardware(controlPanel, ["en"]);

    await expect(next(controlPanel)).toBeDisabled();
    await expect(
      controlPanel.getByText("Download the GPU engine, or use the processor")
    ).toBeVisible();
    await controlPanel
      .getByRole("button", { name: "Download the GPU engine (about 750 MB)" })
      .click();
    await expect(next(controlPanel)).toBeEnabled({ timeout: 15_000 });
  });

  test("an offline engine download says why, offers a retry, and does not finish on the CPU", async ({
    electronApp,
    controlPanel,
  }) => {
    await fakeHardware(electronApp, controlPanel, RTX_3090);
    await stubDownloads(electronApp, controlPanel, {
      engineResult: {
        success: false,
        error: "getaddrinfo ENOTFOUND updates.privatetranscribe.com",
      },
      serverEngine: "cuda",
    });
    await startAtHardware(controlPanel, ["en"]);

    await controlPanel.getByRole("button", { name: "Download", exact: true }).first().click();
    const status = controlPanel.getByTestId("gpu-engine-status");
    await expect(status).toContainText("No connection to the download server", { timeout: 15_000 });
    await expect(
      controlPanel.getByRole("button", { name: "Try the download again" })
    ).toBeVisible();
    await expect(next(controlPanel)).toBeDisabled();
    await controlPanel.getByTestId("onboarding-gpu-engine").scrollIntoViewIfNeeded();
    await shot(controlPanel, "gpu-4-offline");

    // Back online: the retry finishes setup on the GPU.
    await electronApp.evaluate(() => {
      (globalThis as unknown as { __setupStub: StubState }).__setupStub.cfg.engineResult = {
        success: true,
      };
    });
    await controlPanel.getByRole("button", { name: "Try the download again" }).click();
    await expect(next(controlPanel)).toBeEnabled({ timeout: 15_000 });
  });

  test("a card that cannot run the engine says why, and the processor fallback suits Danish", async ({
    electronApp,
    controlPanel,
  }) => {
    await fakeHardware(electronApp, controlPanel, RTX_3090);
    await stubDownloads(electronApp, controlPanel, {
      engineResult: { success: true },
      serverEngine: "cpu",
      diagnostic: { kind: "startup_failure", message: "CUDA driver version is insufficient" },
    });
    await startAtHardware(controlPanel, ["da"]);

    await controlPanel.getByRole("button", { name: "Download", exact: true }).first().click();
    const status = controlPanel.getByTestId("gpu-engine-status");
    await expect(status).toContainText("could not start on this graphics card", {
      timeout: 15_000,
    });
    await expect(status).toContainText("driver");
    await expect(next(controlPanel)).toBeDisabled();
    await controlPanel.getByTestId("onboarding-gpu-engine").scrollIntoViewIfNeeded();
    await shot(controlPanel, "gpu-5-card-failed");

    await controlPanel.getByRole("button", { name: "Use the processor instead" }).click();
    await expect.poll(() => setting(controlPanel, "whisperForceCpu")).toBe("true");
    // Danish on the processor: Turbo, not Base, and the wait is said plainly.
    await expect.poll(() => setting(controlPanel, "whisperModel")).toBe("turbo");
    const note = controlPanel.getByTestId("onboarding-processor-note");
    await expect(note).toContainText("Danish");
    await expect(note).toContainText("slow");
    await expect(controlPanel.getByTestId("onboarding-gpu-engine")).toHaveCount(0);

    await controlPanel.getByRole("button", { name: "Download", exact: true }).first().click();
    await expect(next(controlPanel)).toBeEnabled({ timeout: 15_000 });
    await note.scrollIntoViewIfNeeded();
    await shot(controlPanel, "gpu-6-processor-danish");
  });

  test("going Back to the hardware step keeps the choices made on setup", async ({
    electronApp,
    controlPanel,
  }) => {
    await fakeHardware(electronApp, controlPanel, RTX_3090);
    await stubDownloads(electronApp, controlPanel, {
      engineResult: { success: true },
      serverEngine: "cuda",
    });
    await startAtHardware(controlPanel, ["en"]);

    await controlPanel.getByRole("button", { name: /CPU only/ }).click();
    await expect.poll(() => setting(controlPanel, "whisperForceCpu")).toBe("true");
    await controlPanel.getByRole("button", { name: "Back" }).click();
    await expect(controlPanel.getByText("Settings applied")).toBeVisible();
    await next(controlPanel).click();
    expect(await setting(controlPanel, "whisperForceCpu")).toBe("true");
  });
});

test.describe("Model pick on a PC without NVIDIA", () => {
  test("English gets a quick model; Danish gets Turbo with the wait said plainly", async ({
    electronApp,
    controlPanel,
  }) => {
    await fakeHardware(electronApp, controlPanel, AMD_LAPTOP);
    // Large is on disk so its card can be picked by hand.
    await stubDownloads(electronApp, controlPanel, {
      engineResult: { success: true },
      serverEngine: "cpu",
      modelsOnDisk: ["large"],
    });
    await startAtHardware(controlPanel, ["en"]);

    expect(await setting(controlPanel, "whisperForceCpu")).toBe("true");
    expect(await setting(controlPanel, "whisperModel")).toBe("base");
    const note = controlPanel.getByTestId("onboarding-processor-note");
    await expect(note).toContainText("sized for your processor");
    await expect(controlPanel.getByTestId("onboarding-gpu-engine")).toHaveCount(0);

    await startAtHardware(controlPanel, ["da"]);
    await expect.poll(() => setting(controlPanel, "whisperModel")).toBe("turbo");
    await expect(note).toContainText("Danish");
    await note.scrollIntoViewIfNeeded();
    await shot(controlPanel, "cpu-1-danish");

    // Picking Large by hand on the processor is allowed, and said to be slow.
    await controlPanel.getByRole("button", { name: "Show all models" }).click();
    await controlPanel.getByText("Large", { exact: true }).first().click();
    await expect.poll(() => setting(controlPanel, "whisperModel")).toBe("large");
    await expect(note).toContainText("Whisper Large on the processor is slow");
  });
});

test.describe("Microphone before Allow", () => {
  test.use({ appArgs: FAKE_MIC_ARGS });

  test("no window can open the microphone until Allow is pressed", async ({
    controlPanel,
    overlayWindow,
    userDataDir,
    relaunchElectronApp,
  }) => {
    const tryMic = (page: Page) =>
      page.evaluate(async () => {
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
          stream.getTracks().forEach((t) => t.stop());
          return "granted";
        } catch (error) {
          return (error as Error).name;
        }
      });

    expect(await tryMic(controlPanel)).toBe("NotAllowedError");
    expect(await tryMic(overlayWindow)).toBe("NotAllowedError");

    // The overlay cannot grant itself the microphone.
    const fromOverlay = await overlayWindow.evaluate(() =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).electronAPI.allowMicrophone()
    );
    expect(fromOverlay.allowed).toBe(false);

    await controlPanel.evaluate(() => localStorage.setItem("onboardingCurrentStep", "3"));
    await controlPanel.reload();
    await expect(controlPanel.getByTestId("onboarding-mic-windows-note")).toContainText(
      "Windows does not ask desktop apps"
    );
    await expect(controlPanel.getByRole("button", { name: "Test microphone" })).toBeDisabled();
    await expect(next(controlPanel)).toBeDisabled();
    await shot(controlPanel, "mic-1-before-allow");

    await controlPanel.getByRole("button", { name: "Allow" }).click();
    await expect(controlPanel.getByText("Granted")).toBeVisible();
    await expect(controlPanel.getByRole("button", { name: "Test microphone" })).toBeEnabled();
    await expect(next(controlPanel)).toBeEnabled();
    expect(await tryMic(overlayWindow)).toBe("granted");
    await shot(controlPanel, "mic-2-after-allow");

    const saved = JSON.parse(
      fs.readFileSync(path.join(userDataDir, "microphone-access.json"), "utf8")
    );
    expect(saved).toMatchObject({ allowed: true, source: "user" });

    // Survives a restart without asking again.
    const { overlayWindow: overlay2 } = await relaunchElectronApp();
    expect(await tryMic(overlay2!)).toBe("granted");
  });
});

test.describe("Microphone for someone who finished the old setup", () => {
  test.use({ completeOnboarding: true, appArgs: FAKE_MIC_ARGS });

  test("keeps working after the update, and the answer is saved", async ({
    overlayWindow,
    controlPanel,
    userDataDir,
    relaunchElectronApp,
  }) => {
    const granted = await overlayWindow.evaluate(async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach((t) => t.stop());
        return true;
      } catch {
        return false;
      }
    });
    expect(granted).toBe(true);
    const state = await controlPanel.evaluate(() =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).electronAPI.getMicrophoneAccess()
    );
    expect(state).toMatchObject({ allowed: true, source: "finished-setup-before-gate" });
    expect(fs.existsSync(path.join(userDataDir, "microphone-access.json"))).toBe(true);

    const { overlayWindow: overlay } = await relaunchElectronApp();
    const afterRestart = await overlay!.evaluate(async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach((t) => t.stop());
        return true;
      } catch {
        return false;
      }
    });
    expect(afterRestart).toBe(true);
  });
});

test.describe("Home for someone who finished setup without the engine", () => {
  test.use({ completeOnboarding: true });

  test("says the NVIDIA card is not used, and installs the engine from there", async ({
    electronApp,
    controlPanel,
  }) => {
    await fakeHardware(electronApp, controlPanel, RTX_3090);
    await stubDownloads(electronApp, controlPanel, {
      engineResult: { success: true },
      serverEngine: "cuda",
    });
    await controlPanel.evaluate(() => {
      localStorage.setItem("useLocalWhisper", "true");
      localStorage.setItem("localTranscriptionProvider", "whisper");
      localStorage.setItem("whisperForceCpu", "false");
      localStorage.setItem("whisperModel", "large");
    });
    await controlPanel.reload({ waitUntil: "domcontentloaded" });

    const card = controlPanel.getByTestId("idle-gpu-card");
    await expect(card).toContainText("Your NVIDIA GeForce RTX 3090 is not used");
    await expect(card).toContainText("Whisper Large runs on the processor");
    await shot(controlPanel, "home-1-idle-gpu");

    await card.getByRole("button", { name: "Download the GPU engine" }).click();
    await expect(card).toContainText("Dictation now runs on your NVIDIA GeForce RTX 3090", {
      timeout: 15_000,
    });
    expect((await stubState(electronApp)).engineDownloads).toBe(1);
  });

  test("stays away once the user keeps the processor", async ({ electronApp, controlPanel }) => {
    await fakeHardware(electronApp, controlPanel, RTX_3090);
    await stubDownloads(electronApp, controlPanel, {
      engineResult: { success: true },
      serverEngine: "cuda",
    });
    await controlPanel.evaluate(() => {
      localStorage.setItem("useLocalWhisper", "true");
      localStorage.setItem("localTranscriptionProvider", "whisper");
      localStorage.setItem("whisperForceCpu", "false");
    });
    await controlPanel.reload({ waitUntil: "domcontentloaded" });

    const card = controlPanel.getByTestId("idle-gpu-card");
    await card.getByRole("button", { name: "Keep using the processor" }).click();
    await expect(card).toHaveCount(0);
    await controlPanel.reload({ waitUntil: "domcontentloaded" });
    await expect(controlPanel.getByText("Dashboard", { exact: true })).toBeVisible();
    await expect(controlPanel.getByTestId("idle-gpu-card")).toHaveCount(0);
  });
});
