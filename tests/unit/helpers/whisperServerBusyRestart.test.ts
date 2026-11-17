import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * start() restarts the server whenever it is not ready for the model asked
 * for. Every dictation calls start(), the pre-warm on the hotkey press
 * included, so a restart could land while the server was minutes into a file
 * transcription. The file run then failed with "socket hang up" and all its
 * finished pieces were thrown away.
 */

const WhisperServerManager = require("../../../src/helpers/whisperServer");
const GpuBinaryManager = require("../../../src/helpers/gpuBinaryManager");

const MODEL = "/models/ggml-base.bin";

describe("whisper-server start while a transcription is running", () => {
  let manager: any;

  beforeEach(() => {
    vi.useFakeTimers();
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
  });

  afterEach(() => {
    manager._clearIdleCheck();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("keeps the server when one health probe failed and it answers again", async () => {
    manager.ready = false;
    manager.checkHealth = vi.fn(async () => true);

    await manager.start(MODEL);

    expect(manager.stop).not.toHaveBeenCalled();
    expect(manager._doStart).not.toHaveBeenCalled();
    expect(manager.ready).toBe(true);
  });

  it("keeps probing a silent server and keeps it when it answers again", async () => {
    manager.ready = false;
    const answers = [false, false, true];
    manager.checkHealth = vi.fn(async () => answers.shift() ?? true);

    const starting = manager.start(MODEL);
    await vi.advanceTimersByTimeAsync(5000);
    await starting;

    expect(manager.checkHealth).toHaveBeenCalledTimes(3);
    expect(manager.stop).not.toHaveBeenCalled();
    expect(manager.ready).toBe(true);
  });

  it("restarts a silent server once the transcription has ended", async () => {
    manager.ready = false;
    manager.checkHealth = vi.fn(async () => false);

    const starting = manager.start(MODEL);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(manager.stop).not.toHaveBeenCalled();

    manager.activeTranscriptions = 0;
    await vi.advanceTimersByTimeAsync(2000);
    await starting;

    expect(manager.stop).toHaveBeenCalledOnce();
    expect(manager._doStart).toHaveBeenCalledOnce();
  });

  it("stops waiting for a silent server after 30 seconds and restarts it", async () => {
    manager.ready = false;
    manager.checkHealth = vi.fn(async () => false);

    const starting = manager.start(MODEL);
    await vi.advanceTimersByTimeAsync(29_000);
    expect(manager.stop).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2000);
    await starting;

    expect(manager.stop).toHaveBeenCalledOnce();
    expect(manager._doStart).toHaveBeenCalledOnce();
  });

  it("restarts for another model even while a transcription runs", async () => {
    manager.checkHealth = vi.fn(async () => true);

    await manager.start("/models/ggml-small.bin");

    expect(manager.stop).toHaveBeenCalledOnce();
    expect(manager._doStart).toHaveBeenCalledOnce();
  });

  it("still restarts at once when nothing is being transcribed", async () => {
    manager.ready = false;
    manager.activeTranscriptions = 0;
    manager.checkHealth = vi.fn(async () => true);

    await manager.start(MODEL);

    expect(manager.stop).toHaveBeenCalledOnce();
    expect(manager._doStart).toHaveBeenCalledOnce();
  });

  it("leaves the graphics card retry for later while a transcription runs", async () => {
    vi.spyOn(GpuBinaryManager.prototype, "getCudaBinaryPath").mockReturnValue(
      "/cuda/whisper-server.exe"
    );
    manager.activeServerBinaryPath = "/bin/whisper-server-cpu.exe";
    manager.cudaDisabledForSession = true;
    manager._cudaFailureCount = 1;
    manager._cudaDisabledAt = Date.now() - 60 * 60 * 1000;
    expect(manager.isCudaRetryDue()).toBe(true);

    await manager.start(MODEL);

    expect(manager.stop).not.toHaveBeenCalled();
    expect(manager._doStart).not.toHaveBeenCalled();
  });
});
