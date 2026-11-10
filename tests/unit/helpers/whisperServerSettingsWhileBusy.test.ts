import { tmpdir } from "os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: {
    getPath: () => tmpdir(),
    isReady: () => false,
  },
}));

/**
 * The thread count and the GPU/CPU choice are startup arguments, so applying
 * them means stopping whisper-server. The settings page applied them at once,
 * also while a file was being transcribed. The file run then failed with
 * "socket hang up" and its finished part was lost.
 */

const WhisperServerManager = require("../../../src/helpers/whisperServer");
const WhisperManager = require("../../../src/helpers/whisper");

const MODEL = "/models/ggml-base.bin";

describe("whisper-server settings changed while a transcription runs", () => {
  let manager: any;

  beforeEach(() => {
    manager = new WhisperServerManager();
    manager.process = { pid: undefined };
    manager.ready = true;
    manager.loadedModelPath = MODEL;
    manager.printRealtimeEnabled = false;
    manager.activeTranscriptions = 1;
    manager.stop = vi.fn(async () => {
      manager.process = null;
      manager.ready = false;
    });
    manager._doStart = vi.fn(async () => {});
    manager.checkHealth = vi.fn(async () => true);
  });

  afterEach(() => {
    manager._clearIdleCheck();
    vi.restoreAllMocks();
  });

  it("takes a new thread count without stopping the server under the transcription", async () => {
    await manager.setThreads(4);

    expect(manager.threadSetting).toBe(4);
    expect(manager.stop).not.toHaveBeenCalled();
  });

  it("takes the processor-only choice without stopping the server under the transcription", async () => {
    await manager.setForceCpu(true);

    expect(manager.forceCpu).toBe(true);
    expect(manager.stop).not.toHaveBeenCalled();
  });

  it("keeps the server through an engine update that lands during the transcription", async () => {
    await manager.invalidateServerCache({ stopRunningServer: true });

    expect(manager.stop).not.toHaveBeenCalled();
  });

  it("keeps serving while the transcription runs and restarts on the first start after it", async () => {
    await manager.setThreads(4);

    await manager.start(MODEL);
    expect(manager.stop).not.toHaveBeenCalled();

    manager.activeTranscriptions = 0;
    await manager.start(MODEL);

    expect(manager.stop).toHaveBeenCalledOnce();
    expect(manager._doStart).toHaveBeenCalledOnce();

    // The change is applied once, not on every later start.
    manager.process = { pid: undefined };
    manager.ready = true;
    manager.loadedModelPath = MODEL;
    await manager.start(MODEL);
    expect(manager.stop).toHaveBeenCalledOnce();
  });

  it("still stops the server at once when nothing is being transcribed", async () => {
    manager.activeTranscriptions = 0;

    await manager.setThreads(4);

    expect(manager.stop).toHaveBeenCalledOnce();
  });
});

// A warm server is used without a start() call, so the transcription path has
// to ask for the waiting restart itself. Without that the old thread count or
// GPU choice stayed in use until the server was unloaded for some other reason.
describe("a transcription after a settings change that had to wait", () => {
  let whisper: any;
  let server: any;

  beforeEach(() => {
    whisper = new WhisperManager();
    server = whisper.serverManager;
    whisper.currentServerModel = "base";
    server.process = { pid: undefined };
    server.ready = true;
    server.stoppedDueToIdle = false;
    server.loadedModelPath = whisper.getModelPath("base");
    server.printRealtimeEnabled = false;
    server.stop = vi.fn(async () => {
      server.process = null;
      server.ready = false;
    });
    server._doStart = vi.fn(async () => {
      server.process = { pid: undefined };
      server.ready = true;
      server.loadedModelPath = whisper.getModelPath("base");
    });
    server.transcribe = vi.fn(async () => ({ text: "hello" }));
    server.getEngineStatus = vi.fn(() => ({ effectiveEngine: "cpu" }));
  });

  afterEach(() => {
    server._clearIdleCheck();
    vi.restoreAllMocks();
  });

  it("restarts the server with the new setting before the next transcription", async () => {
    server.activeTranscriptions = 1;
    await server.setThreads(4);
    server.activeTranscriptions = 0;

    await whisper.transcribeViaServer(Buffer.from("audio"), "base", "en");

    expect(server.stop).toHaveBeenCalledOnce();
    expect(server._doStart).toHaveBeenCalledOnce();
    expect(server.transcribe).toHaveBeenCalledOnce();

    await whisper.transcribeViaServer(Buffer.from("audio"), "base", "en");
    expect(server.stop).toHaveBeenCalledOnce();
  });

  it("leaves the server alone for a transcription that overlaps the one it waits for", async () => {
    server.activeTranscriptions = 1;
    await server.setThreads(4);

    await whisper.transcribeViaServer(Buffer.from("audio"), "base", "en");

    expect(server.stop).not.toHaveBeenCalled();
    expect(server.restartPendingForSettings).toBe(true);
  });
});
