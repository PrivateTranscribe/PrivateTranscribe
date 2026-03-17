import { describe, it, expect } from "vitest";

// Import pure helpers from benchmarkManager (CJS module)
const {
  generateSilentWav,
  computeRealtimeFactor,
  buildBenchmarkRecord,
  formatRealtimeFactor,
  BENCHMARK_AUDIO_DURATION_SEC,
} = require("../../../src/helpers/benchmarkManager");

// ── generateSilentWav ────────────────────────────────────────────────────

describe("generateSilentWav", () => {
  it("generates a valid WAV header for 1-second silence", () => {
    const buf = generateSilentWav(1);

    // WAV header: RIFF....WAVE
    expect(buf.toString("ascii", 0, 4)).toBe("RIFF");
    expect(buf.toString("ascii", 8, 12)).toBe("WAVE");
    expect(buf.toString("ascii", 12, 16)).toBe("fmt ");
    expect(buf.toString("ascii", 36, 40)).toBe("data");

    // PCM format = 1
    expect(buf.readUInt16LE(20)).toBe(1);
    // 1 channel
    expect(buf.readUInt16LE(22)).toBe(1);
    // 16 kHz sample rate
    expect(buf.readUInt32LE(24)).toBe(16000);
    // 16-bit samples
    expect(buf.readUInt16LE(34)).toBe(16);

    // Data size: 16000 samples * 2 bytes = 32000
    const dataSize = buf.readUInt32LE(40);
    expect(dataSize).toBe(32000);

    // Total buffer: 44 header + 32000 data
    expect(buf.length).toBe(44 + 32000);
  });

  it("generates correct length for 10 seconds", () => {
    const buf = generateSilentWav(10);
    const expectedDataSize = 16000 * 10 * 2; // 320000 bytes
    expect(buf.readUInt32LE(40)).toBe(expectedDataSize);
    expect(buf.length).toBe(44 + expectedDataSize);
  });

  it("generates silence (all PCM samples are zero)", () => {
    const buf = generateSilentWav(1);
    const pcmData = buf.slice(44);
    const allZero = pcmData.every((b: number) => b === 0);
    expect(allZero).toBe(true);
  });

  it("rejects invalid duration", () => {
    expect(() => generateSilentWav(0)).toThrow();
    expect(() => generateSilentWav(-1)).toThrow();
    expect(() => generateSilentWav(61)).toThrow();
    expect(() => generateSilentWav(NaN)).toThrow();
  });

  it("accepts fractional durations", () => {
    const buf = generateSilentWav(0.5);
    // 0.5s * 16000 * 2 = 16000 bytes
    expect(buf.readUInt32LE(40)).toBe(16000);
  });
});

// ── computeRealtimeFactor ────────────────────────────────────────────────

describe("computeRealtimeFactor", () => {
  it("computes correct factor", () => {
    // 10s audio processed in 1s = 10x
    expect(computeRealtimeFactor(10, 1000)).toBe(10);
  });

  it("handles fast processing", () => {
    // 10s audio in 100ms = 100x
    expect(computeRealtimeFactor(10, 100)).toBe(100);
  });

  it("handles slow processing", () => {
    // 10s audio in 20s = 0.5x
    expect(computeRealtimeFactor(10, 20000)).toBe(0.5);
  });

  it("returns 0 for zero elapsed time", () => {
    expect(computeRealtimeFactor(10, 0)).toBe(0);
  });

  it("returns 0 for negative elapsed time", () => {
    expect(computeRealtimeFactor(10, -100)).toBe(0);
  });
});

// ── buildBenchmarkRecord ─────────────────────────────────────────────────

describe("buildBenchmarkRecord", () => {
  it("builds a complete record with all fields", () => {
    const rec = buildBenchmarkRecord({
      provider: "whisper",
      model: "turbo",
      gpuCategory: "cpu_only",
      audioDurationSec: 10,
      elapsedMs: 2000,
      gpuModel: null,
      cpuModel: "Intel i7-12700K",
      cpuCores: 20,
    });

    expect(rec.id).toBeTruthy();
    expect(rec.provider).toBe("whisper");
    expect(rec.model).toBe("turbo");
    expect(rec.gpuCategory).toBe("cpu_only");
    expect(rec.audioDurationSec).toBe(10);
    expect(rec.elapsedMs).toBe(2000);
    expect(rec.realtimeFactor).toBe(5);
    expect(rec.cpuModel).toBe("Intel i7-12700K");
    expect(rec.cpuCores).toBe(20);
    expect(rec.gpuModel).toBeNull();
    expect(rec.createdAt).toBeTruthy();
  });

  it("rounds elapsed time to integer", () => {
    const rec = buildBenchmarkRecord({
      provider: "nvidia",
      model: "parakeet-tdt-0.6b-v3",
      gpuCategory: "nvidia_cuda",
      audioDurationSec: 10,
      elapsedMs: 456.789,
      gpuModel: "RTX 4090",
      cpuModel: null,
      cpuCores: null,
    });

    expect(rec.elapsedMs).toBe(457);
  });

  it("rounds realtimeFactor to 2 decimal places", () => {
    const rec = buildBenchmarkRecord({
      provider: "whisper",
      model: "base",
      gpuCategory: "cpu_only",
      audioDurationSec: 10,
      elapsedMs: 3333,
    });

    // 10 / 3.333 = 3.0003... → 3.0
    expect(rec.realtimeFactor).toBe(3);
  });

  it("defaults missing fields", () => {
    const rec = buildBenchmarkRecord({
      audioDurationSec: 10,
      elapsedMs: 1000,
    });

    expect(rec.provider).toBe("unknown");
    expect(rec.model).toBe("unknown");
    expect(rec.gpuCategory).toBe("cpu_only");
    expect(rec.gpuModel).toBeNull();
    expect(rec.cpuModel).toBeNull();
    expect(rec.cpuCores).toBeNull();
  });

  it("generates unique IDs", () => {
    const a = buildBenchmarkRecord({ audioDurationSec: 10, elapsedMs: 1000 });
    const b = buildBenchmarkRecord({ audioDurationSec: 10, elapsedMs: 1000 });
    expect(a.id).not.toBe(b.id);
  });
});

// ── formatRealtimeFactor ─────────────────────────────────────────────────

describe("formatRealtimeFactor", () => {
  it("formats high values without decimals", () => {
    expect(formatRealtimeFactor(150)).toBe("150x real-time");
    expect(formatRealtimeFactor(100)).toBe("100x real-time");
  });

  it("formats medium values with 1 decimal", () => {
    expect(formatRealtimeFactor(12.34)).toBe("12.3x real-time");
    expect(formatRealtimeFactor(10)).toBe("10.0x real-time");
  });

  it("formats low values with 2 decimals", () => {
    expect(formatRealtimeFactor(3.456)).toBe("3.46x real-time");
    expect(formatRealtimeFactor(0.5)).toBe("0.50x real-time");
  });

  it("returns dash for invalid values", () => {
    expect(formatRealtimeFactor(0)).toBe("—");
    expect(formatRealtimeFactor(-1)).toBe("—");
    expect(formatRealtimeFactor(NaN)).toBe("—");
    expect(formatRealtimeFactor(Infinity)).toBe("—");
  });
});

// ── Constants ─────────────────────────────────────────────────────────────

describe("constants", () => {
  it("exports BENCHMARK_AUDIO_DURATION_SEC as 10", () => {
    expect(BENCHMARK_AUDIO_DURATION_SEC).toBe(10);
  });
});
