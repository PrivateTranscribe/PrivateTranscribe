import path from "node:path";
import { cloudFile } from "./fixtures/cloud-file";
import { expect, test } from "./fixtures/electron-app";

const wav = path.resolve("tests/fixtures/multispeaker/control.wav");

type FallbackProbe = {
  observed: boolean;
  aborted: boolean;
  jobId: string | null;
  hasSignal: boolean;
};

test("Cancel stops a cloud file request after it falls back to local Whisper", async ({
  controlPanel,
  electronApp,
}) => {
  await cloudFile(controlPanel, electronApp);

  await electronApp.evaluate(({ app: electronApp }) => {
    const { createRequire } = (process as any).getBuiltinModule("module");
    const mainRequire = createRequire(`${electronApp.getAppPath()}/main.js`);
    const WhisperManager = mainRequire("./src/helpers/whisper");
    const globals = globalThis as typeof globalThis & {
      __fallbackProbe?: FallbackProbe;
      __originalFallbackTranscribe?: typeof WhisperManager.prototype.transcribeLocalWhisper;
    };
    globals.__fallbackProbe = {
      observed: false,
      aborted: false,
      jobId: null,
      hasSignal: false,
    };
    globals.__originalFallbackTranscribe = WhisperManager.prototype.transcribeLocalWhisper;
    WhisperManager.prototype.transcribeLocalWhisper = function (
      _audio: unknown,
      options: { jobId?: string; signal?: AbortSignal } = {}
    ) {
      const probe = globals.__fallbackProbe!;
      probe.observed = true;
      probe.jobId = typeof options.jobId === "string" ? options.jobId : null;
      probe.hasSignal = options.signal instanceof AbortSignal;

      return new Promise((_resolve, reject) => {
        options.signal?.addEventListener(
          "abort",
          () => {
            probe.aborted = true;
            reject(Object.assign(new Error("Transcription cancelled"), { cancelled: true }));
          },
          { once: true }
        );
      });
    };
  });

  try {
    await controlPanel.evaluate(() => {
      localStorage.setItem("allowLocalFallback", "true");
      const fixtureFetch = window.fetch;
      window.fetch = async (input, init) => {
        if (String(input).includes("/audio/transcriptions")) {
          throw new Error("Cloud unavailable");
        }
        return fixtureFetch(input, init);
      };
    });

    await controlPanel.locator('input[type="file"]').setInputFiles(wav);
    await expect
      .poll(() => electronApp.evaluate(() => (globalThis as any).__fallbackProbe as FallbackProbe))
      .toMatchObject({ observed: true, hasSignal: true });

    const probe = await electronApp.evaluate(
      () => (globalThis as any).__fallbackProbe as FallbackProbe
    );
    expect(probe.jobId).toMatch(/^file-/);

    await controlPanel.getByRole("button", { name: "Cancel", exact: true }).click();

    await expect
      .poll(() => electronApp.evaluate(() => Boolean((globalThis as any).__fallbackProbe?.aborted)))
      .toBe(true);
    await expect(
      controlPanel.getByRole("heading", { name: "Cancelled", exact: true })
    ).toBeVisible();
    await expect(controlPanel.getByRole("heading", { name: "Transcription failed" })).toHaveCount(
      0
    );

    const secondCancel = await controlPanel.evaluate((jobId) => {
      return (window as any).electronAPI.cancelFileTranscription(jobId);
    }, probe.jobId);
    expect(secondCancel).toMatchObject({ success: true, cancelled: false, jobs: 0 });
  } finally {
    await electronApp.evaluate(({ app: electronApp }) => {
      const { createRequire } = (process as any).getBuiltinModule("module");
      const mainRequire = createRequire(`${electronApp.getAppPath()}/main.js`);
      const WhisperManager = mainRequire("./src/helpers/whisper");
      const globals = globalThis as typeof globalThis & {
        __fallbackProbe?: FallbackProbe;
        __originalFallbackTranscribe?: typeof WhisperManager.prototype.transcribeLocalWhisper;
      };
      if (globals.__originalFallbackTranscribe) {
        WhisperManager.prototype.transcribeLocalWhisper = globals.__originalFallbackTranscribe;
      }
      delete globals.__originalFallbackTranscribe;
      delete globals.__fallbackProbe;
    });
  }
});
