import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

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
  fs.mkdirSync(path.dirname(path.join(dir, DEFAULT_SEGMENTATION_RELATIVE_PATH)), { recursive: true });
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
    const manager = new DiarizationManager({ modelsDir: makeTempModelsDir(), loadSherpa: () => ({}) });
    const config = manager.buildConfig({ threshold: 0.8 });

    expect(config.clustering.numClusters).toBe(-1);
    expect(config.clustering.threshold).toBe(0.8);
    expect(config.segmentation.pyannote.model).toContain("model.int8.onnx");
  });

  it("builds sherpa config for expected speaker count", () => {
    const manager = new DiarizationManager({ modelsDir: makeTempModelsDir(), loadSherpa: () => ({}) });
    const config = manager.buildConfig({ expectedSpeakers: 3 });

    expect(config.clustering.numClusters).toBe(3);
  });

  it("caps label-only auto-detected speaker segments without throwing", async () => {
    const manager = new DiarizationManager({
      modelsDir: makeTempModelsDir(),
      loadSherpa: () => ({
        OfflineSpeakerDiarization: class {
          sampleRate = 16000;

          process() {
            return Array.from({ length: 7 }, (_, index) => ({
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
  });
});
