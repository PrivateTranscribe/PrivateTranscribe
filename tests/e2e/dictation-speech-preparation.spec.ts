import fs from "node:fs";
import path from "node:path";
import { test, expect } from "./fixtures/electron-app";

const enabled = process.env.PT_RUN_DICTATION_ACCURACY === "1";
const fixturePath = path.resolve("tmp/dictation-integrated-comparison/four-minute-mid-pause.wav");
const reportPath = path.resolve("tmp/dictation-integrated-comparison/results.json");

test.describe("real microphone pipeline with a long pause", () => {
  test.skip(
    !enabled,
    "Opt-in real-model test; run the dictation benchmark to generate its fixture first"
  );
  test.use({
    seedRealWhisperModels: ["turbo"],
    seedCudaEngine: true,
    fakeAudioCaptureFile: fixturePath,
    appEnv: { PT_LOG_LEVEL: "debug" },
  });

  test("records the ending and persists it without invented closing words", async ({
    electronApp,
    controlPanel,
    overlayWindow,
    userDataDir,
  }) => {
    test.setTimeout(420000);
    const reference = JSON.parse(fs.readFileSync(reportPath, "utf8")).cases.find(
      (c: any) => c.name === "four-minute-mid-pause"
    );
    await controlPanel.evaluate(() => {
      for (const [key, value] of Object.entries({
        useLocalWhisper: "true",
        localTranscriptionProvider: "whisper",
        whisperModel: "turbo",
        preferredLanguage: "en",
        whisperForceCpu: "false",
        useReasoningModel: "false",
        autoPaste: "false",
        copyToClipboard: "false",
        historyLimit: "50",
        audioFeedback: "false",
        pauseMediaOnRecord: "false",
        musicDuckingMode: "off",
        actionEngineEnabled: "false",
        customDictionary: "[]",
      }))
        localStorage.setItem(key, value);
    });
    await overlayWindow.reload({ waitUntil: "domcontentloaded" });
    // Exercise the actual worker under Electron before spending four minutes
    // recording. A plain Node smoke test does not cover Electron's V8 sandbox.
    const workerStatus = await electronApp.evaluate(async (_electron, root) => {
      const { createRequire } = (process as any).getBuiltinModule("module");
      const mainRequire = createRequire(root + "/main.js");
      const fs = mainRequire("fs");
      const { prepareDictationSpeech } = mainRequire(root + "/src/helpers/dictationSpeechRunner");
      const wav = fs.readFileSync(root + "/tests/fixtures/dictation/banana.wav");
      const result = await prepareDictationSpeech(wav.subarray(44));
      return { available: result.available, reason: result.reason, regions: result.regions };
    }, path.resolve("."));
    expect(workerStatus.available, JSON.stringify(workerStatus)).toBe(true);
    expect(workerStatus.regions).toBeGreaterThan(0);

    const toggle = () =>
      electronApp.evaluate(({ BrowserWindow }) => {
        const overlay = BrowserWindow.getAllWindows().find(
          (w) => !w.isDestroyed() && !w.webContents.getURL().includes("panel=true")
        );
        if (!overlay) throw new Error("Missing overlay");
        overlay.webContents.send("toggle-dictation");
      });
    const halo = overlayWindow.locator(
      'div[aria-hidden="true"][style*="width: 68px"][style*="radial-gradient"]'
    );
    await toggle();
    await expect(halo).toHaveCount(1, { timeout: 30000 });
    // Stop in the final silence, before Chromium loops the fake microphone.
    const recordMs = Math.floor((reference.seconds - 1) * 1000);
    for (let elapsed = 0; elapsed < recordMs; elapsed += 30000) {
      await overlayWindow.waitForTimeout(Math.min(30000, recordMs - elapsed));
      console.log(`Recorded ${Math.min(elapsed + 30000, recordMs)}/${recordMs} ms`);
    }
    await toggle();
    await expect(halo).toHaveCount(0, { timeout: 60000 });
    let rows: any[] = [];
    await expect
      .poll(
        async () => {
          rows = await controlPanel.evaluate(() =>
            (window as any).electronAPI.getTranscriptions(10)
          );
          return rows.length;
        },
        { timeout: 60000 }
      )
      .toBe(1);
    const { scoreCase } = require("../../scripts/dictation-ending-benchmark-utils");
    const score = scoreCase(reference, rows[0].text);
    expect(score.passed, JSON.stringify(score)).toBe(true);
    const logsDir = path.join(userDataDir, "logs");
    const logs = fs
      .readdirSync(logsDir)
      .filter((f) => f.endsWith(".log"))
      .map((f) => fs.readFileSync(path.join(logsDir, f), "utf8"))
      .join("\n");
    expect(logs).toContain("Prepared dictation speech");
    const evidenceDir = path.resolve("docs/qa-dictation-comparison-2026-09-09");
    fs.writeFileSync(
      path.join(evidenceDir, "electron-recording-result.json"),
      JSON.stringify({ recordMs, text: rows[0].text, score, workerStatus }, null, 2)
    );
  });
});
