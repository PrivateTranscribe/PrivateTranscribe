import fs from "fs";
import path from "path";
import { test, expect } from "./fixtures/electron-app";

/**
 * The GPU half of the first run with nothing faked: this PC's real hardware
 * detection, the real ~750 MB engine download from the update server into a
 * throwaway profile, and Whisper Large really loaded onto the graphics card.
 *
 * Opt-in (PT_E2E_REAL_GPU=1): it needs an NVIDIA card and the network, and it
 * downloads the engine every run. The model is the machine's own file,
 * hardlinked in, so no model download happens.
 */

const OUT = process.env.PT_CAPTURE_DIR || "test-results/first-run";

test.skip(process.env.PT_E2E_REAL_GPU !== "1", "Set PT_E2E_REAL_GPU=1 on a PC with an NVIDIA card");
test.use({ completeOnboarding: false, seedRealWhisperModels: ["large"] });
test.setTimeout(15 * 60_000);

test("setup installs the engine and proves Whisper runs on the card", async ({
  controlPanel,
  userDataDir,
}) => {
  await controlPanel.evaluate(() => {
    localStorage.setItem("onboardingCurrentStep", "1");
    localStorage.setItem("spokenLanguages", JSON.stringify(["en"]));
    localStorage.setItem("preferredLanguage", "en");
  });
  await controlPanel.reload({ waitUntil: "domcontentloaded" });
  await expect(controlPanel.getByText("Settings applied")).toBeVisible({ timeout: 60_000 });
  await controlPanel.getByRole("button", { name: "Next" }).click();

  const next = controlPanel.getByRole("button", { name: "Next" });
  await expect(next).toBeDisabled();
  expect(await controlPanel.evaluate(() => localStorage.getItem("whisperModel"))).toBe("large");

  await controlPanel.getByRole("button", { name: "Download the GPU engine (about 750 MB)" }).click();
  const status = controlPanel.getByTestId("gpu-engine-status");
  await expect(status).toHaveText(/^Dictation runs on your NVIDIA/, { timeout: 12 * 60_000 });
  await expect(next).toBeEnabled();

  expect(fs.existsSync(path.join(userDataDir, "bin", "whisper-server-win32-x64-cuda.exe"))).toBe(
    true
  );
  fs.mkdirSync(OUT, { recursive: true });
  await controlPanel.getByTestId("onboarding-gpu-engine").scrollIntoViewIfNeeded();
  await controlPanel.setViewportSize({ width: 1232, height: 788 });
  await controlPanel.screenshot({ path: path.join(OUT, "real-gpu-ready.png") });

  const engine = await controlPanel.evaluate(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const s = await (window as any).electronAPI.getCudaBinaryStatus();
    return s.engineStatus?.effectiveEngine;
  });
  expect(engine).toBe("cuda");
});
