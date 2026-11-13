import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ElectronApplication, Page } from "@playwright/test";
import { expect, test } from "./fixtures/electron-app";
import {
  catchInstance,
  configureLocalWhisperDictation,
  endLeftoverEngines,
  recordPastes,
  repeatWav,
  toggleDictation,
} from "./fixtures/app-drive";
import { startStubServer } from "./fixtures/local-stub-server";

/**
 * The local Whisper engine has to survive what a user does while it works.
 *
 * Each test runs the real whisper-server on the CPU with the Base model and
 * real audio, through the Transcribe page, and then does the one thing that
 * used to take the engine down:
 *
 *   - a dictation press while a file is being transcribed, with the server
 *     marked not ready the way one slow health probe marks it,
 *   - a changed thread count while a file is being transcribed,
 *   - an old engine process that closes long after the next one has started.
 *
 * The last test is about the answer itself: a letter such as "ø" whose two
 * bytes arrive in different network reads has to come out whole. The engine's
 * answer is played by a stand-in there, because the real engine cannot be told
 * where to cut.
 */
test.use({
  appEnv: { WHISPER_FORCE_CPU: "true" },
  seedRealWhisperModels: ["base"],
  fakeAudioCaptureFile: path.resolve(__dirname, "..", "fixtures", "dictation", "banana.wav"),
});

const INTERVIEW_WAV = path.resolve(__dirname, "..", "fixtures", "multispeaker", "interview.wav");
const BANANA_WAV = path.resolve(__dirname, "..", "fixtures", "dictation", "banana.wav");

type EngineState = {
  pid: number | null;
  ready: boolean;
  inFlight: number;
  startsWhileBusyAndNotReady: number;
  threadChangesWhileBusy: number[];
  port: number | null;
  spawnArgs: string[];
  spawnPid: number | null;
};

/** Sixteen minutes of speech: a decode of some fifteen seconds, long enough to act during. */
let longWav = "";
test.beforeAll(() => {
  longWav = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pt-e2e-audio-")), "long.wav");
  repeatWav(INTERVIEW_WAV, 10, longWav);
});
test.afterAll(() => {
  fs.rmSync(path.dirname(longWav), { recursive: true, force: true });
});

async function prepare(app: ElectronApplication, overlay: Page, panel: Page): Promise<void> {
  await catchInstance(app, {
    key: "whisperServer",
    modulePath: "src/helpers/whisperServer.js",
    method: "start",
  });
  await recordPastes(app);
  // Note the two moments the tests are about, as the engine manager meets
  // them: a start while it is busy and marked not ready, and a thread count
  // that changes while it is busy.
  await app.evaluate(() => {
    const g = globalThis as unknown as {
      __ptE2eRequire: (file: string) => any;
      __ptE2eLive: Record<string, any>;
    };
    const live = g.__ptE2eLive;
    const proto = g.__ptE2eRequire("src/helpers/whisperServer.js").prototype;
    live.startsWhileBusyAndNotReady = 0;
    live.threadChangesWhileBusy = [];

    const start = proto.start;
    proto.start = function (this: any, ...args: unknown[]) {
      if (this.process && this.ready === false && this.activeTranscriptions > 0) {
        live.startsWhileBusyAndNotReady += 1;
      }
      return start.apply(this, args);
    };

    const setThreads = proto.setThreads;
    proto.setThreads = function (this: any, value: unknown) {
      if (this.activeTranscriptions > 0) live.threadChangesWhileBusy.push(Number(value));
      return setThreads.call(this, value);
    };
  });
  await configureLocalWhisperDictation(overlay);

  await panel.evaluate(() => {
    localStorage.setItem("fileTranscriptionSpeakerDetection", "false");
    localStorage.setItem("fileTranscriptionLanguage", "en");
  });
  await panel.reload({ waitUntil: "domcontentloaded" });
  await panel.evaluate(() =>
    (window as unknown as { electronAPI: any }).electronAPI.setWhisperForceCpu(true)
  );
  await panel.getByRole("button", { name: "Transcribe File", exact: true }).click();
  await expect(panel.getByRole("heading", { name: "Transcribe", exact: true })).toBeVisible();
}

function engineState(app: ElectronApplication): Promise<EngineState | null> {
  return app.evaluate(() => {
    const live = (globalThis as unknown as { __ptE2eLive?: Record<string, any> }).__ptE2eLive;
    const manager = live?.whisperServer;
    if (!live || !manager) return null;
    return {
      pid: manager.process?.pid ?? null,
      ready: manager.ready === true,
      inFlight: manager.activeTranscriptions ?? 0,
      startsWhileBusyAndNotReady: live.startsWhileBusyAndNotReady ?? 0,
      threadChangesWhileBusy: live.threadChangesWhileBusy ?? [],
      port: manager.port ?? null,
      spawnArgs: manager.lastSpawn?.args ?? [],
      spawnPid: manager.lastSpawn?.pid ?? null,
    };
  });
}

const chooseFile = (panel: Page, file: string) =>
  panel.locator('input[type="file"]').setInputFiles(file);

async function expectDone(panel: Page, timeout: number): Promise<string> {
  const done = panel.getByRole("heading", { name: "Done" });
  const failed = panel.getByRole("heading", { name: "Transcription failed" });
  await expect(done.or(failed)).toBeVisible({ timeout });
  await expect(failed, "the file transcription failed").toHaveCount(0);
  return (await panel.locator("textarea[readonly]").inputValue()).trim();
}

/** Start the long file and wait until the engine is really decoding it. */
async function startLongRun(app: ElectronApplication, panel: Page): Promise<number> {
  await chooseFile(panel, longWav);
  await expect(panel.getByRole("heading", { name: "Transcribing…" })).toBeVisible({
    timeout: 60_000,
  });
  await expect
    .poll(async () => (await engineState(app))?.inFlight ?? 0, { timeout: 60_000 })
    .toBe(1);
  const pid = (await engineState(app))!.pid;
  expect(Number(pid)).toBeGreaterThan(0);
  return pid as number;
}

test.describe("local Whisper engine under load", () => {
  test.describe.configure({ mode: "serial" });

  test("a dictation press leaves a busy engine alone when it was marked not ready", async ({
    electronApp,
    overlayWindow,
    controlPanel,
  }) => {
    test.setTimeout(420_000);
    await prepare(electronApp, overlayWindow, controlPanel);
    const pidDuringRun = await startLongRun(electronApp, controlPanel);

    // What one failed health probe on a busy PC leaves behind.
    await electronApp.evaluate(() => {
      (
        globalThis as unknown as { __ptE2eLive: Record<string, any> }
      ).__ptE2eLive.whisperServer.ready = false;
    });
    // The hotkey press warms the engine up, which is the call that restarted it.
    await toggleDictation(electronApp);

    await expect
      .poll(async () => (await engineState(electronApp))?.startsWhileBusyAndNotReady, {
        timeout: 20_000,
        message: "the hotkey press never reached the busy engine",
      })
      .toBeGreaterThan(0);
    // Long enough for a restart to have happened, had one been coming.
    await overlayWindow.waitForTimeout(3_000);
    await overlayWindow.keyboard.press("Escape");

    const text = await expectDone(controlPanel, 300_000);
    expect(text.length).toBeGreaterThan(200);
    expect((await engineState(electronApp))?.pid).toBe(pidDuringRun);
  });

  test("a changed thread count waits for the file run and applies to the next one", async ({
    electronApp,
    overlayWindow,
    controlPanel,
  }) => {
    test.setTimeout(420_000);
    await prepare(electronApp, overlayWindow, controlPanel);
    const pidDuringRun = await startLongRun(electronApp, controlPanel);

    // The setting changes in another window. The Transcribe page hears it and
    // sends it on exactly as the Settings page does, without leaving the run.
    await overlayWindow.evaluate(() => localStorage.setItem("whisperThreads", "2"));

    await expect
      .poll(async () => (await engineState(electronApp))?.threadChangesWhileBusy, {
        timeout: 15_000,
        message: "the changed thread count never reached the busy engine",
      })
      .toContain(2);

    const text = await expectDone(controlPanel, 300_000);
    expect(text.length).toBeGreaterThan(200);
    expect((await engineState(electronApp))?.pid).toBe(pidDuringRun);

    // The next transcription starts the engine again, with the new setting.
    await chooseFile(controlPanel, BANANA_WAV);
    expect((await expectDone(controlPanel, 120_000)).toLowerCase()).toContain("banana");
    const after = (await engineState(electronApp))!;
    expect(after.pid).not.toBe(pidDuringRun);
    expect(after.spawnArgs.join(" ")).toContain("--threads 2");
  });

  test("an engine that closes long after its stop cannot take the next one down", async ({
    electronApp,
    overlayWindow,
    controlPanel,
  }) => {
    test.setTimeout(300_000);
    await prepare(electronApp, overlayWindow, controlPanel);
    const pids: Array<number | null> = [];

    try {
      await chooseFile(controlPanel, BANANA_WAV);
      await expectDone(controlPanel, 120_000);
      const firstPid = (await engineState(electronApp))!.pid;
      pids.push(firstPid);
      expect(Number(firstPid)).toBeGreaterThan(0);

      // The first engine hangs on its way out: it ignores the stop and the
      // forced kill, the way a process stuck in the graphics driver does.
      await electronApp.evaluate(() => {
        const live = (globalThis as unknown as { __ptE2eLive: Record<string, any> }).__ptE2eLive;
        const child = live.whisperServer.process;
        live.hungChild = child;
        live.hungPid = child.pid;
        child.kill = () => true;
        // taskkill is handed this instead and finds nothing to end.
        Object.defineProperty(child, "pid", { configurable: true, get: () => 4_194_300 });
      });

      // A settings change with nothing in flight stops the engine at once. The
      // app waits five seconds for the close, then moves on without it.
      await overlayWindow.evaluate(() => localStorage.setItem("whisperThreads", "3"));
      await expect
        .poll(async () => (await engineState(electronApp))?.pid ?? null, { timeout: 20_000 })
        .toBeNull();

      await chooseFile(controlPanel, BANANA_WAV);
      await expectDone(controlPanel, 120_000);
      const secondPid = (await engineState(electronApp))!.pid;
      pids.push(secondPid);
      expect(Number(secondPid)).toBeGreaterThan(0);
      expect(secondPid).not.toBe(firstPid);

      // Now the hung engine finally closes.
      await electronApp.evaluate(() => {
        const live = (globalThis as unknown as { __ptE2eLive: Record<string, any> }).__ptE2eLive;
        process.kill(live.hungPid);
      });
      await expect
        .poll(
          () =>
            electronApp.evaluate(
              () =>
                (globalThis as unknown as { __ptE2eLive: Record<string, any> }).__ptE2eLive
                  .hungChild.exitCode !== null
            ),
          { timeout: 15_000 }
        )
        .toBe(true);
      await controlPanel.waitForTimeout(1_000);

      const afterLateClose = (await engineState(electronApp))!;
      expect(afterLateClose.pid, "the late close cleared the running engine").toBe(secondPid);
      expect(afterLateClose.ready).toBe(true);

      // And the next transcription uses the engine that is running, not a third.
      await chooseFile(controlPanel, BANANA_WAV);
      expect((await expectDone(controlPanel, 120_000)).toLowerCase()).toContain("banana");
      const last = (await engineState(electronApp))!;
      pids.push(last.pid, last.spawnPid);
      expect(last.spawnPid, "a third engine was started").toBe(secondPid);
    } finally {
      const state = await engineState(electronApp).catch(() => null);
      pids.push(state?.pid, state?.spawnPid);
      await electronApp
        .evaluate(() => {
          const live = (globalThis as unknown as { __ptE2eLive: Record<string, any> }).__ptE2eLive;
          // Once it has closed, its number may belong to another program.
          return live.hungChild?.exitCode === null ? live.hungPid : null;
        })
        .then((pid) => pids.push(pid))
        .catch(() => {});
      // The app stops the engine it knows about when it closes. One it lost
      // track of would stay behind on this PC, so end those here.
      test.info().annotations.push({ type: "engine pids", description: pids.join(", ") });
      leftoverPids.push(...pids);
    }
  });

  test("a letter split across two network reads comes out whole", async ({
    electronApp,
    overlayWindow,
    controlPanel,
  }) => {
    test.setTimeout(240_000);
    await prepare(electronApp, overlayWindow, controlPanel);

    // A real transcription first, so the engine is up and the app is using it.
    await chooseFile(controlPanel, BANANA_WAV);
    expect((await expectDone(controlPanel, 120_000)).toLowerCase()).toContain("banana");
    const realPort = (await engineState(electronApp))!.port;

    const danish = "Rød grød med fløde, blåbær på låget og en æske æbler til søen.";
    const engine = await startStubServer(async (request, reply) => {
      if (request.method !== "POST") return reply.json({ status: "ok" });
      await reply.jsonInPieces({
        text: ` ${danish}`,
        language: "da",
        segments: [{ start: 0, end: 4, text: ` ${danish}` }],
      });
    });

    try {
      // The next request goes to the stand-in, through the app's own client.
      await electronApp.evaluate((_electron, port) => {
        (
          globalThis as unknown as { __ptE2eLive: Record<string, any> }
        ).__ptE2eLive.whisperServer.port = port;
      }, engine.port);

      await chooseFile(controlPanel, BANANA_WAV);
      const text = await expectDone(controlPanel, 120_000);

      expect(engine.requests.some((request) => request.method === "POST")).toBe(true);
      expect(text).not.toContain("�");
      // The page puts a time stamp in front of the text.
      expect(text).toContain(danish);
    } finally {
      await electronApp
        .evaluate((_electron, port) => {
          (
            globalThis as unknown as { __ptE2eLive: Record<string, any> }
          ).__ptE2eLive.whisperServer.port = port;
        }, realPort)
        .catch(() => {});
      await engine.close();
    }
  });
});

const leftoverPids: Array<number | null | undefined> = [];
test.afterEach(() => {
  endLeftoverEngines(leftoverPids.splice(0));
});
