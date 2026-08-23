import { tmpdir } from "os";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: {
    getPath: () => tmpdir(),
    isReady: () => false,
  },
}));

const GpuBinaryManager = require("../../../src/helpers/gpuBinaryManager");

type Progress = {
  phase: string;
  percent: number;
  bytesDownloaded?: number;
  totalBytes?: number;
};

/**
 * Replaces the real download with one the test drives by hand, so the shared
 * state machine in downloadCudaBinary (the part these tests care about) still
 * runs for real.
 */
function stubDownload(manager: any) {
  let release!: (result: unknown) => void;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const runner = vi.fn(async () => {
    await gate;
    return { success: true, binaryPath: "C:/fake/whisper-server-cuda.exe" };
  });
  manager._runCudaDownload = runner;
  return {
    runner,
    emit: (progress: Progress) => manager._emitProgress(progress),
    finish: () => release({ success: true, binaryPath: "C:/fake/whisper-server-cuda.exe" }),
  };
}

describe("GpuBinaryManager concurrent downloads", () => {
  let manager: any;

  beforeEach(() => {
    manager = new GpuBinaryManager();
    // Tests run on whatever host platform; pin a supported key so the spec
    // lookup succeeds everywhere.
    manager.getPlatformKey = () => "win32-x64";
  });

  it("joins an in-flight download instead of failing with 'already in progress'", async () => {
    const { runner, finish } = stubDownload(manager);

    const first = manager.downloadCudaBinary();
    const second = manager.downloadCudaBinary();

    finish();
    const [firstResult, secondResult] = await Promise.all([first, second]);

    // The old behaviour returned {success:false, error:"CUDA binary download
    // already in progress"} here, which Settings rendered as a red error under
    // an "Update CUDA Engine" button that had, in fact, worked.
    expect(firstResult).toEqual({ success: true, binaryPath: "C:/fake/whisper-server-cuda.exe" });
    expect(secondResult).toEqual(firstResult);
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it("replays the latest progress to a caller that joins mid-download", async () => {
    const { emit, finish } = stubDownload(manager);

    const first = manager.downloadCudaBinary();
    emit({ phase: "downloading", percent: 42, bytesDownloaded: 315_000_000 });

    const joinerProgress: Progress[] = [];
    const second = manager.downloadCudaBinary((p: Progress) => joinerProgress.push(p));

    // Without the replay the joiner's progress bar would sit at 0% until the
    // next chunk arrived, which for a 750 MB package can be seconds of nothing.
    expect(joinerProgress[0]).toMatchObject({ percent: 42 });

    emit({ phase: "downloading", percent: 43 });
    finish();
    await Promise.all([first, second]);

    expect(joinerProgress.map((p) => p.percent)).toEqual([42, 43]);
  });

  it("emits progress to the app-wide listener for a download nobody subscribed to", async () => {
    const broadcast = vi.fn();
    manager.setDownloadProgressListener(broadcast);
    const { emit, finish } = stubDownload(manager);

    // The startup auto-update calls downloadGpuBinary() with no callback; this
    // is the path that used to be completely invisible in the UI.
    const running = manager.downloadCudaBinary();
    emit({ phase: "downloading", percent: 10 });
    emit({ phase: "installing", percent: 99 });
    finish();
    await running;

    expect(broadcast.mock.calls.map(([p]) => p.phase)).toEqual(["downloading", "installing"]);
  });

  it("reports an in-flight download through getDownloadState and clears it afterwards", async () => {
    const { emit, finish } = stubDownload(manager);

    expect(manager.getDownloadState()).toEqual({ downloading: false, progress: null });

    const running = manager.downloadCudaBinary();
    emit({ phase: "downloading", percent: 66, bytesDownloaded: 495_000_000 });

    // This is what a Settings window opened mid-download reads on mount.
    expect(manager.getDownloadState()).toEqual({
      downloading: true,
      progress: { phase: "downloading", percent: 66, bytesDownloaded: 495_000_000 },
    });

    finish();
    await running;

    // A stale 100% here would leave the card stuck showing a progress bar.
    expect(manager.getDownloadState()).toEqual({ downloading: false, progress: null });
  });

  it("keeps the download alive when a subscriber throws", async () => {
    const { emit, finish } = stubDownload(manager);
    const running = manager.downloadCudaBinary(() => {
      throw new Error("renderer went away");
    });

    expect(() => emit({ phase: "downloading", percent: 5 })).not.toThrow();

    finish();
    await expect(running).resolves.toMatchObject({ success: true });
  });

  it("allows a fresh download after the previous one finished", async () => {
    const firstRun = stubDownload(manager);
    const first = manager.downloadCudaBinary();
    firstRun.finish();
    await first;

    const secondRun = stubDownload(manager);
    const second = manager.downloadCudaBinary();
    secondRun.finish();
    await second;

    expect(secondRun.runner).toHaveBeenCalledTimes(1);
  });
});
