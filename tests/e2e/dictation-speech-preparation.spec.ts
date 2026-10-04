import fs from "node:fs";
import path from "node:path";
import { test, expect } from "./fixtures/electron-app";
import { evidenceDir } from "./fixtures/evidence";

const enabled = process.env.PT_RUN_DICTATION_ACCURACY === "1";
const fixturePath = path.resolve("tmp/dictation-integrated-comparison/four-minute-mid-pause.wav");
const reportPath = path.resolve("tmp/dictation-integrated-comparison/results.json");
const suitePath = process.env.PT_DICTATION_RECORDING_SUITE;
const recordings = suitePath
  ? JSON.parse(fs.readFileSync(path.resolve(suitePath), "utf8"))
  : [{ name: "four-minute-mid-pause", model: "turbo", fixturePath }];

for (const recording of recordings)
  test.describe(`real microphone pipeline ${recording.name} ${recording.model}`, () => {
    test.skip(
      !enabled,
      "Opt-in real-model test; run the dictation benchmark to generate its fixture first"
    );
    test.use({
      seedRealWhisperModels: [recording.model],
      seedCudaEngine: true,
      fakeAudioCaptureFile: recording.fixturePath,
      appEnv: { PT_LOG_LEVEL: "debug" },
    });

    test("records the ending and persists it without invented closing words", async ({
      electronApp,
      controlPanel,
      overlayWindow,
      userDataDir,
    }) => {
      const reference = suitePath
        ? recording
        : JSON.parse(fs.readFileSync(reportPath, "utf8")).cases.find(
            (c: any) => c.name === "four-minute-mid-pause"
          );
      test.setTimeout(Math.ceil(reference.seconds * 1000) + 180000);
      await controlPanel.evaluate((model) => {
        for (const [key, value] of Object.entries({
          useLocalWhisper: "true",
          localTranscriptionProvider: "whisper",
          whisperModel: model,
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
      }, recording.model);
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
          { timeout: 120000 }
        )
        .toBe(1);
      const { scoreCase } = require("../../scripts/dictation-ending-benchmark-utils");
      const score = scoreCase(reference, rows[0].text);
      const { scoreLongDictation } = require("../../scripts/long-dictation-test-utils");
      const coverage = suitePath
        ? scoreLongDictation(
            {
              referenceText: reference.reference,
              boundaryChecks: reference.boundaryChecks,
            },
            rows[0].text,
            { maximumWordErrorRate: 0.1, minimumBoundaryRecall: 0.85 }
          )
        : null;
      const logsDir = path.join(userDataDir, "logs");
      const logs = fs
        .readdirSync(logsDir)
        .filter((f) => f.endsWith(".log"))
        .map((f) => fs.readFileSync(path.join(logsDir, f), "utf8"))
        .join("\n");
      const resultsDir = evidenceDir("qa-dictation-comparison-2026-09-09");
      fs.mkdirSync(resultsDir, { recursive: true });
      const evidenceName = suitePath
        ? `recording-${recording.name}-${recording.model}.json`
        : "electron-recording-result.json";
      fs.writeFileSync(
        path.join(resultsDir, evidenceName),
        JSON.stringify(
          {
            name: recording.name,
            model: recording.model,
            fixtureSha256: reference.sha256,
            recordMs,
            text: rows[0].text,
            score,
            coverage,
            workerStatus,
            speechPreparationObserved: logs.includes("Prepared dictation speech"),
          },
          null,
          2
        )
      );
      expect(logs).toContain("Prepared dictation speech");
      expect(score.passed, JSON.stringify(score)).toBe(true);
      if (coverage) expect(coverage.passed, JSON.stringify(coverage)).toBe(true);
    });
  });
