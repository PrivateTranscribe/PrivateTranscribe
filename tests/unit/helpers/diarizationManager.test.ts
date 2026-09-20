import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

const {
  DiarizationManager,
  DEFAULT_EMBEDDING_RELATIVE_PATH,
  DEFAULT_SEGMENTATION_RELATIVE_PATH,
  copyFloat32Samples,
  normalizeDiarizationResult,
  normalizeSpeakerId,
} = require("../../../src/helpers/diarizationManager");

const tempDirs: string[] = [];

function makeTempModelsDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-diarization-test-"));
  tempDirs.push(dir);
  fs.mkdirSync(path.dirname(path.join(dir, DEFAULT_SEGMENTATION_RELATIVE_PATH)), {
    recursive: true,
  });
  fs.writeFileSync(path.join(dir, DEFAULT_SEGMENTATION_RELATIVE_PATH), "segmentation");
  fs.writeFileSync(path.join(dir, DEFAULT_EMBEDDING_RELATIVE_PATH), "embedding");
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("DiarizationManager", () => {
  it("normalizes speaker ids", () => {
    expect(normalizeSpeakerId(0)).toBe("SPEAKER_00");
    expect(normalizeSpeakerId("2")).toBe("SPEAKER_02");
    expect(normalizeSpeakerId("speaker-10")).toBe("SPEAKER_10");
  });

  it("normalizes diarization results", () => {
    const result = normalizeDiarizationResult([
      { speaker: 0, start: 0.1234, end: 1.5678 },
      { speaker: 1, start: 2, end: 3 },
    ]);

    expect(result.success).toBe(true);
    expect(result.speakerCount).toBe(2);
    expect(result.speakers).toEqual(["SPEAKER_00", "SPEAKER_01"]);
    expect(result.segments[0]).toMatchObject({ start: 0.123, end: 1.568 });
  });

  it("copies sherpa wave samples into a JS-owned Float32Array", () => {
    const samples = new Float32Array([0.1, -0.2, 0.3]);
    const copy = copyFloat32Samples(samples);

    expect(copy).toBeInstanceOf(Float32Array);
    expect(copy).not.toBe(samples);
    expect(Array.from(copy)).toEqual(Array.from(samples));

    samples[0] = 0.9;
    expect(copy[0]).toBeCloseTo(0.1);
  });

  it("reports missing model files", () => {
    const modelsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-diarization-missing-"));
    tempDirs.push(modelsDir);
    const manager = new DiarizationManager({ modelsDir, loadSherpa: () => ({}) });

    expect(manager.getModelStatus().ready).toBe(false);
    expect(() => manager.buildConfig()).toThrow(/not downloaded/);
  });

  it("builds sherpa config for auto speaker count", () => {
    const manager = new DiarizationManager({
      modelsDir: makeTempModelsDir(),
      loadSherpa: () => ({}),
    });
    const config = manager.buildConfig({ threshold: 0.8 });

    expect(config.clustering.numClusters).toBe(-1);
    expect(config.clustering.threshold).toBe(0.8);
    expect(config.segmentation.pyannote.model).toContain("model.int8.onnx");
  });

  it("builds sherpa config for expected speaker count", () => {
    const manager = new DiarizationManager({
      modelsDir: makeTempModelsDir(),
      loadSherpa: () => ({}),
    });
    const config = manager.buildConfig({ expectedSpeakers: 3 });

    expect(config.clustering.numClusters).toBe(3);
  });

  it("reclusters excess speakers by voice using the same native instance", async () => {
    let instances = 0;
    const setConfig = vi.fn();
    const manager = new DiarizationManager({
      modelsDir: makeTempModelsDir(),
      loadSherpa: () => ({
        OfflineSpeakerDiarization: class {
          sampleRate = 16000;
          count = 7;
          constructor() {
            instances += 1;
          }
          setConfig(config: any) {
            setConfig(config);
            this.count = config.clustering.numClusters;
          }

          process() {
            return Array.from({ length: this.count }, (_, index) => ({
              label: index,
              start: index,
              end: index + 1,
            }));
          }
        },
        readWave: () => ({ sampleRate: 16000, samples: new Float32Array(16000 * 7) }),
      }),
    });

    const result = await manager.diarizeWavFile("unused.wav", { maxSpeakers: 6 });

    expect(result.success).toBe(true);
    expect(result.speakerCount).toBeLessThanOrEqual(6);
    expect(instances).toBe(1);
    expect(setConfig).toHaveBeenCalledWith({ clustering: { numClusters: 6, threshold: 0.9 } });
  });

  it.each([0, -1, 1.01, 2])(
    "rejects native-crashing threshold %s before loading sherpa",
    (threshold) => {
      const loadSherpa = vi.fn();
      const manager = new DiarizationManager({ modelsDir: makeTempModelsDir(), loadSherpa });
      expect(() => manager.buildConfig({ threshold })).toThrow(/threshold/);
      expect(loadSherpa).not.toHaveBeenCalled();
    }
  );

  it("cancels an active worker, waits for its exit, and removes its payload", async () => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(),
    });
    let payloadPath = "";
    const spawn = vi.fn((_exe, args) => {
      payloadPath = args[1];
      return child;
    });
    const manager = new DiarizationManager({ modelsDir: makeTempModelsDir(), spawn });
    const controller = new AbortController();
    const pending = manager.diarizeWavFileInWorker("test.wav", { signal: controller.signal });
    const rejected = expect(pending).rejects.toMatchObject({
      cancelled: true,
      code: "TRANSCRIPTION_CANCELLED",
    });
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
    expect(JSON.parse(fs.readFileSync(payloadPath, "utf8")).options).not.toHaveProperty("signal");
    controller.abort();
    expect(child.kill).toHaveBeenCalledOnce();
    expect(fs.existsSync(payloadPath)).toBe(true);
    child.emit("close", null);
    await rejected;
    expect(fs.existsSync(payloadPath)).toBe(false);
  });

  it("does not spawn work for a cancelled request", async () => {
    const spawn = vi.fn();
    const manager = new DiarizationManager({ spawn });
    const controller = new AbortController();
    controller.abort();
    await expect(
      manager.diarizeWavBufferInWorker(Buffer.from("wav"), { signal: controller.signal })
    ).rejects.toMatchObject({ cancelled: true });
    expect(spawn).not.toHaveBeenCalled();
  });

  it("cleans up the abort listener after successful worker completion", async () => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(),
    });
    const spawn = vi.fn(() => child);
    const manager = new DiarizationManager({ spawn });
    const controller = new AbortController();
    const pending = manager.diarizeWavFileInWorker("test.wav", { signal: controller.signal });
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
    child.stdout.write(JSON.stringify({ success: true, result: { segments: [] } }));
    child.emit("close", 0);
    await expect(pending).resolves.toEqual({ segments: [] });
    controller.abort();
    expect(child.kill).not.toHaveBeenCalled();
  });
});
