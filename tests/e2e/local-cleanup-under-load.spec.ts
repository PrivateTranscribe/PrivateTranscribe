import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ElectronApplication, Page } from "@playwright/test";
import { BETA_FEATURES_KEY } from "../../src/utils/betaFeatures";
import { expect, test } from "./fixtures/electron-app";
import {
  catchInstance,
  configureLocalWhisperDictation,
  endLeftoverEngines,
  readMainLog,
  readPastes,
  recordingHalo,
  recordPastes,
  tapMainLog,
  toggleDictation,
} from "./fixtures/app-drive";
import { startStubServer } from "./fixtures/local-stub-server";

/**
 * AI cleanup with a model on this PC, driven through real dictations.
 *
 * Each test dictates the banana clip through the fake microphone, a real
 * Whisper decode and the real llama-server with the suggested cleanup model,
 * all on the CPU. Then it does the one thing that used to go wrong:
 *
 *   - Escape while the cleanup is being answered,
 *   - the model's unload timer running out while the cleanup is being answered,
 *   - an answer whose "ø" arrives as two network reads (played by a stand-in,
 *     because the real server cannot be told where to cut).
 *
 * The cleanup model is not downloaded here. It has to be on the machine
 * already, and the spec says so when it is not.
 */
const CLEANUP_MODEL_ID = "qwen3.8-2b-distill-q4_k_m";
const CLEANUP_MODEL_FILE = "Qwen3.8-2B-Q4_K_M.gguf";
const FIXTURE_DIR = path.resolve(__dirname, "..", "fixtures", "dictation");

test.use({
  fakeAudioCaptureFile: path.join(FIXTURE_DIR, "banana.wav"),
  seedRealWhisperModels: ["base"],
  appEnv: { WHISPER_FORCE_CPU: "true" },
});

type CleanupState = {
  pid: number | null;
  ready: boolean;
  inFlight: number;
  port: number | null;
  serviceBusy: boolean;
  /** How the last request to the model ended: with its answer, or without one. */
  lastEnded: "answered" | "dropped" | null;
  idleChecksWhileAnswering: number;
};

/** Make the machine's own cleanup model visible in the throwaway home. */
function linkCleanupModel(fakeHome: string): void {
  const source = path.join(
    os.homedir(),
    ".cache",
    "PrivateTranscribe",
    "models",
    CLEANUP_MODEL_FILE
  );
  expect(
    fs.existsSync(source),
    `the cleanup model is not on this machine. Download "${CLEANUP_MODEL_ID}" in the app first. Missing: ${source}`
  ).toBe(true);
  const dir = path.join(fakeHome, ".cache", "PrivateTranscribe", "models");
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, CLEANUP_MODEL_FILE);
  if (fs.existsSync(dest)) return;
  try {
    fs.linkSync(source, dest);
  } catch {
    fs.copyFileSync(source, dest);
  }
}

async function prepare(
  app: ElectronApplication,
  overlay: Page,
  fakeHome: string | null
): Promise<void> {
  if (!fakeHome) throw new Error("this spec needs the throwaway home the whisper seed creates");
  linkCleanupModel(fakeHome);

  await catchInstance(app, {
    key: "llamaServer",
    modulePath: "src/helpers/llamaServer.js",
    method: "start",
  });
  await tapMainLog(app);
  await recordPastes(app);
  // Count the requests being answered, and the unload checks that run during
  // one. The spec keeps its own count, so it reads the same on app code that
  // has no such count of its own.
  await app.evaluate(() => {
    const g = globalThis as unknown as {
      __ptE2eRequire: (file: string) => any;
      __ptE2eLive: Record<string, any>;
    };
    const live = g.__ptE2eLive;
    const proto = g.__ptE2eRequire("src/helpers/llamaServer.js").prototype;
    live.cleanupsBeingAnswered = 0;
    live.idleChecksWhileAnswering = 0;

    const inference = proto.inference;
    proto.inference = function (this: unknown, ...args: unknown[]) {
      live.cleanupsBeingAnswered += 1;
      const ended = (how: "answered" | "dropped") => () => {
        live.cleanupsBeingAnswered -= 1;
        live.lastCleanupEnded = how;
      };
      const result = inference.apply(this, args);
      Promise.resolve(result).then(ended("answered"), ended("dropped"));
      return result;
    };

    const check = proto.checkIdleAndStop;
    proto.checkIdleAndStop = function (this: unknown) {
      if (live.cleanupsBeingAnswered > 0) live.idleChecksWhileAnswering += 1;
      return check.call(this);
    };
  });

  await configureLocalWhisperDictation(overlay, {
    [BETA_FEATURES_KEY]: "true",
    useReasoningModel: "true",
    reasoningProvider: "local",
    reasoningModel: CLEANUP_MODEL_ID,
  });

  const models: Array<{ id: string; isDownloaded?: boolean }> = await overlay.evaluate(() =>
    (window as unknown as { electronAPI: any }).electronAPI.modelGetAll()
  );
  expect(
    models.find((model) => model.id === CLEANUP_MODEL_ID)?.isDownloaded,
    "the app does not see the cleanup model as downloaded"
  ).toBe(true);
}

function cleanupState(app: ElectronApplication): Promise<CleanupState> {
  return app.evaluate(() => {
    const g = globalThis as unknown as {
      __ptE2eRequire: (file: string) => any;
      __ptE2eLive: Record<string, any>;
    };
    const manager = g.__ptE2eLive.llamaServer;
    const service = g.__ptE2eRequire("src/services/localReasoningBridge.js").default;
    return {
      pid: manager?.process?.pid ?? null,
      ready: manager?.ready === true,
      inFlight: g.__ptE2eLive.cleanupsBeingAnswered ?? 0,
      port: manager?.port ?? null,
      serviceBusy: service.isProcessing === true,
      lastEnded: g.__ptE2eLive.lastCleanupEnded ?? null,
      idleChecksWhileAnswering: g.__ptE2eLive.idleChecksWhileAnswering ?? 0,
    };
  });
}

/** Speak the clip and press stop. What happens after that is the test's. */
async function speak(app: ElectronApplication, overlay: Page): Promise<void> {
  await toggleDictation(app);
  await expect(recordingHalo(overlay)).toHaveCount(1, { timeout: 30_000 });
  await overlay.waitForTimeout(6_000);
  await toggleDictation(app);
}

/** The cleanup's request has reached llama-server and is being answered. */
const waitUntilAnswering = (app: ElectronApplication) =>
  expect
    .poll(async () => (await cleanupState(app)).inFlight, {
      timeout: 180_000,
      message: "no cleanup request reached llama-server",
    })
    .toBe(1);

const stagesSeen = async (app: ElectronApplication, stage: string) =>
  (await readMainLog(app)).filter((line) => line.message === stage).length;

const pids: Array<number | null> = [];
test.afterEach(async ({ electronApp }) => {
  pids.push((await cleanupState(electronApp).catch(() => null))?.pid ?? null);
  endLeftoverEngines(pids.splice(0));
});

test.describe("local AI cleanup under load", () => {
  test.describe.configure({ mode: "serial" });

  test("Escape during the cleanup stops it and leaves it free for the next dictation", async ({
    electronApp,
    overlayWindow,
    fakeHomeDir,
  }) => {
    test.setTimeout(600_000);
    await prepare(electronApp, overlayWindow, fakeHomeDir);

    await speak(electronApp, overlayWindow);
    await waitUntilAnswering(electronApp);
    await overlayWindow.keyboard.press("Escape");

    // The request to the model is dropped at once, not left to run out.
    await overlayWindow.waitForTimeout(1_500);
    const afterCancel = await cleanupState(electronApp);
    expect(afterCancel.inFlight, "the cancelled cleanup is still being answered").toBe(0);
    // Dropped, not answered in the meantime: a quick model must not pass this.
    expect(afterCancel.lastEnded, "the cancelled cleanup ran on to its answer").toBe("dropped");
    expect(afterCancel.serviceBusy, "the cleanup service is still held").toBe(false);
    expect(afterCancel.pid, "the model was unloaded by the cancel").not.toBeNull();
    expect(await readPastes(electronApp)).toHaveLength(0);

    // The next dictation is cleaned up and pasted, not refused as busy.
    const successesBefore = await stagesSeen(electronApp, "LOCAL_BRIDGE_SUCCESS");
    await speak(electronApp, overlayWindow);
    await expect
      .poll(async () => (await readPastes(electronApp)).length, { timeout: 300_000 })
      .toBe(1);

    expect(await stagesSeen(electronApp, "LOCAL_BRIDGE_SUCCESS")).toBe(successesBefore + 1);
    const pastes = await readPastes(electronApp);
    expect(pastes[0].text.toLowerCase()).toContain("banana");
  });

  test("the model is not unloaded while it answers a cleanup", async ({
    electronApp,
    overlayWindow,
    fakeHomeDir,
  }) => {
    test.setTimeout(600_000);
    await prepare(electronApp, overlayWindow, fakeHomeDir);

    await speak(electronApp, overlayWindow);
    await waitUntilAnswering(electronApp);
    const pidWhileAnswering = (await cleanupState(electronApp)).pid;

    // The unload timer runs out now, in the middle of the answer.
    await electronApp.evaluate(() => {
      const manager = (globalThis as unknown as { __ptE2eLive: Record<string, any> }).__ptE2eLive
        .llamaServer;
      manager.idleTimeoutMs = 400;
      manager.lastUsedTime = Date.now() - 60_000;
      manager._scheduleIdleCheck();
    });

    await expect
      .poll(async () => (await readPastes(electronApp)).length, { timeout: 300_000 })
      .toBe(1);

    const state = await cleanupState(electronApp);
    expect(
      state.idleChecksWhileAnswering,
      "the unload timer never ran out during the answer, so nothing was tested"
    ).toBeGreaterThan(0);
    expect(await stagesSeen(electronApp, "LOCAL_BRIDGE_SUCCESS")).toBe(1);
    expect(await stagesSeen(electronApp, "LOCAL_BRIDGE_ERROR")).toBe(0);
    expect((await readPastes(electronApp))[0].text.toLowerCase()).toContain("banana");
    expect(Number(pidWhileAnswering)).toBeGreaterThan(0);

    // With the answer in, the timer does its work: the model unloads.
    await expect
      .poll(async () => (await cleanupState(electronApp)).pid, { timeout: 20_000 })
      .toBeNull();
  });

  test("a letter split across two network reads comes out whole in the cleaned text", async ({
    electronApp,
    overlayWindow,
    fakeHomeDir,
  }) => {
    test.setTimeout(600_000);
    await prepare(electronApp, overlayWindow, fakeHomeDir);

    // A real cleanup first, so llama-server is up and the app is using it.
    await speak(electronApp, overlayWindow);
    await expect
      .poll(async () => (await readPastes(electronApp)).length, { timeout: 300_000 })
      .toBe(1);
    const realPort = (await cleanupState(electronApp)).port;

    const danish = "Jeg lagde bananen i min rygsæk i går, sammen med rødgrød og en æske blåbær.";
    const model = await startStubServer(async (request, reply) => {
      if (request.method !== "POST") return reply.json({ status: "ok" });
      await reply.jsonInPieces({
        choices: [
          { index: 0, finish_reason: "stop", message: { role: "assistant", content: danish } },
        ],
      });
    });

    try {
      // The next cleanup request goes to the stand-in, through the app's client.
      await electronApp.evaluate((_electron, port) => {
        (
          globalThis as unknown as { __ptE2eLive: Record<string, any> }
        ).__ptE2eLive.llamaServer.port = port;
      }, model.port);

      await speak(electronApp, overlayWindow);
      await expect
        .poll(async () => (await readPastes(electronApp)).length, { timeout: 300_000 })
        .toBe(2);

      expect(model.requests.some((request) => request.method === "POST")).toBe(true);
      const text = (await readPastes(electronApp))[1].text;
      expect(text).not.toContain("�");
      expect(text).toContain(danish);
    } finally {
      await electronApp
        .evaluate((_electron, port) => {
          (
            globalThis as unknown as { __ptE2eLive: Record<string, any> }
          ).__ptE2eLive.llamaServer.port = port;
        }, realPort)
        .catch(() => {});
      await model.close();
    }
  });
});
