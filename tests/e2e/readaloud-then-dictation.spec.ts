import fs from "node:fs";
import path from "node:path";
import { test, expect } from "./fixtures/electron-app";

test.use({
  seedKokoroModel: true,
  seedRealWhisperModels: ["base"],
  fakeAudioCaptureFile: path.resolve("tests/fixtures/dictation/banana.wav"),
  appEnv: { WHISPER_FORCE_CPU: "true", PT_LOG_LEVEL: "debug" },
});

test("dictates after finished and stopped Read Aloud without closing the app", async ({
  electronApp,
  controlPanel,
  overlayWindow,
  userDataDir,
}) => {
  test.setTimeout(180_000);
  await controlPanel.evaluate(async () => {
    const settings = {
      useLocalWhisper: "true",
      localTranscriptionProvider: "whisper",
      whisperModel: "base",
      preferredLanguage: "en",
      whisperForceCpu: "true",
      useReasoningModel: "false",
      autoPaste: "false",
      copyToClipboard: "false",
      audioFeedback: "false",
      pauseMediaOnRecord: "false",
      musicDuckingMode: "off",
      actionEngineEnabled: "false",
      customDictionary: "[]",
    };
    for (const [key, value] of Object.entries(settings)) localStorage.setItem(key, value);
    await (window as any).electronAPI.setWhisperForceCpu(true);
  });
  await overlayWindow.reload({ waitUntil: "domcontentloaded" });
  await overlayWindow.waitForFunction(() => Boolean((window as any).__readAloudTest));
  const engine = await overlayWindow.evaluate(() =>
    (window as any).electronAPI.readAloudLoadEngine()
  );
  expect(engine.loaded).toBe(true);

  const toggle = () =>
    electronApp.evaluate(({ BrowserWindow }) => {
      const overlay = BrowserWindow.getAllWindows().find(
        (win) => !win.isDestroyed() && !win.webContents.getURL().includes("panel=true")
      );
      if (!overlay) throw new Error("Overlay disappeared");
      overlay.webContents.send("toggle-dictation");
    });
  const halo = overlayWindow.locator(
    'div[aria-hidden="true"][style*="width: 68px"][style*="radial-gradient"]'
  );

  for (const [index, ending] of ["finished", "stopped", "finished", "stopped"].entries()) {
    await overlayWindow.evaluate(() =>
      (window as any).__readAloudTest.speak("This sentence is read aloud before recording.")
    );
    await expect
      .poll(() => overlayWindow.evaluate(() => (window as any).__readAloudTest.getState().status))
      .toBe("playing");
    if (ending === "stopped") {
      await overlayWindow.evaluate(() => (window as any).__readAloudTest.stop());
    }
    await expect
      .poll(() => overlayWindow.evaluate(() => (window as any).__readAloudTest.getState().status))
      .toBe(ending);

    await toggle();
    await expect(halo).toHaveCount(1);
    await overlayWindow.waitForTimeout(8000);
    await toggle();
    await expect(halo).toHaveCount(0);
    await expect
      .poll(
        () =>
          controlPanel.evaluate(
            async () => (await (window as any).electronAPI.getTranscriptions(10)).length
          ),
        { timeout: 45_000 }
      )
      .toBe(index + 1);
    const rows = await controlPanel.evaluate(() =>
      (window as any).electronAPI.getTranscriptions(10)
    );
    expect(rows.some((row: { text: string }) => row.text.toLowerCase().includes("backpack"))).toBe(
      true
    );
    expect(electronApp.process().exitCode).toBeNull();
    console.log(`Read Aloud ${ending} -> dictation ${index + 1} saved; app alive`);
  }

  const logs = fs
    .readdirSync(path.join(userDataDir, "logs"))
    .filter((file) => file.endsWith(".log"))
    .map((file) => fs.readFileSync(path.join(userDataDir, "logs", file), "utf8"))
    .join("\n");
  expect(logs).toContain("Prepared dictation speech");
  expect(logs).not.toContain("Speech preparation unavailable");
});
