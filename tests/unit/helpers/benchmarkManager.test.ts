import { describe, it, expect } from "vitest";

// Import pure helpers from benchmarkManager (CJS module)
const {
  generateBenchmarkAudio,
  computeRealtimeFactor,
  buildBenchmarkRecord,
  formatRealtimeFactor,
  computeSpeedup,
  buildComparisonRecord,
  formatSpeedup,
  BENCHMARK_AUDIO_DURATION_SEC,
} = require("../../../src/helpers/benchmarkManager");

// ── generateBenchmarkAudio ───────────────────────────────────────────────

describe("generateBenchmarkAudio", () => {
  it("generates a valid WAV header for 1-second audio", () => {
    const buf = generateBenchmarkAudio(1);

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
    const buf = generateBenchmarkAudio(10);
    const expectedDataSize = 16000 * 10 * 2; // 320000 bytes
    expect(buf.readUInt32LE(40)).toBe(expectedDataSize);
    expect(buf.length).toBe(44 + expectedDataSize);
  });

  it("generates non-silent audio (contains non-zero PCM samples)", () => {
    const buf = generateBenchmarkAudio(1);
    const pcmData = buf.slice(44);
    const hasNonZero = pcmData.some((b: number) => b !== 0);
    expect(hasNonZero).toBe(true);
  });

  it("produces deterministic output (same bytes on every call)", () => {
    const buf1 = generateBenchmarkAudio(1);
    const buf2 = generateBenchmarkAudio(1);
    expect(buf1.equals(buf2)).toBe(true);
  });

  it("rejects invalid duration", () => {
    expect(() => generateBenchmarkAudio(0)).toThrow();
    expect(() => generateBenchmarkAudio(-1)).toThrow();
    expect(() => generateBenchmarkAudio(61)).toThrow();
    expect(() => generateBenchmarkAudio(NaN)).toThrow();
  });

  it("accepts fractional durations", () => {
    const buf = generateBenchmarkAudio(0.5);
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
    expect(formatRealtimeFactor(0)).toBe("-");
    expect(formatRealtimeFactor(-1)).toBe("-");
    expect(formatRealtimeFactor(NaN)).toBe("-");
    expect(formatRealtimeFactor(Infinity)).toBe("-");
  });
});

// ── computeSpeedup ───────────────────────────────────────────────────────

describe("computeSpeedup", () => {
  it("computes correct speedup ratio", () => {
    // GPU is 5x faster than CPU: 50x / 10x = 5
    expect(computeSpeedup(10, 50)).toBe(5);
  });

  it("handles GPU being slower than CPU", () => {
    // GPU 2x, CPU 5x → speedup = 0.4
    expect(computeSpeedup(5, 2)).toBe(0.4);
  });

  it("rounds to 2 decimal places", () => {
    // 30 / 7 = 4.2857... → 4.29
    expect(computeSpeedup(7, 30)).toBe(4.29);
  });

  it("returns 0 for zero CPU factor", () => {
    expect(computeSpeedup(0, 10)).toBe(0);
  });

  it("returns 0 for negative CPU factor", () => {
    expect(computeSpeedup(-5, 10)).toBe(0);
  });

  it("returns 0 for non-finite inputs", () => {
    expect(computeSpeedup(NaN, 10)).toBe(0);
    expect(computeSpeedup(10, NaN)).toBe(0);
    expect(computeSpeedup(Infinity, 10)).toBe(0);
  });

  it("handles equal speeds", () => {
    expect(computeSpeedup(5, 5)).toBe(1);
  });
});

// ── buildComparisonRecord ────────────────────────────────────────────────

describe("buildComparisonRecord", () => {
  const cpuResult = buildBenchmarkRecord({
    provider: "whisper",
    model: "turbo",
    gpuCategory: "nvidia_cuda",
    audioDurationSec: 10,
    elapsedMs: 2000,
    cpuModel: "Intel i7",
    cpuCores: 8,
  });

  const gpuResult = buildBenchmarkRecord({
    provider: "nvidia",
    model: "parakeet-tdt-0.6b-v3",
    gpuCategory: "nvidia_cuda",
    audioDurationSec: 10,
    elapsedMs: 400,
    gpuModel: "RTX 4090",
    cpuModel: "Intel i7",
    cpuCores: 8,
  });

  it("builds a record with all required fields", () => {
    const comp = buildComparisonRecord({ cpuResult, gpuResult });

    expect(comp.id).toBeTruthy();
    expect(comp.cpuResult).toBe(cpuResult);
    expect(comp.gpuResult).toBe(gpuResult);
    expect(comp.speedup).toBeGreaterThan(0);
    expect(comp.createdAt).toBeTruthy();
  });

  it("computes correct speedup from embedded results", () => {
    const comp = buildComparisonRecord({ cpuResult, gpuResult });
    // CPU: 10/2 = 5x, GPU: 10/0.4 = 25x → speedup = 25/5 = 5
    expect(comp.speedup).toBe(5);
  });

  it("generates unique IDs", () => {
    const a = buildComparisonRecord({ cpuResult, gpuResult });
    const b = buildComparisonRecord({ cpuResult, gpuResult });
    expect(a.id).not.toBe(b.id);
  });
});

// ── formatSpeedup ────────────────────────────────────────────────────────

describe("formatSpeedup", () => {
  it("formats high speedups without decimals", () => {
    expect(formatSpeedup(150)).toBe("150x faster");
    expect(formatSpeedup(100)).toBe("100x faster");
  });

  it("formats medium speedups with 1 decimal", () => {
    expect(formatSpeedup(12.34)).toBe("12.3x faster");
    expect(formatSpeedup(10)).toBe("10.0x faster");
  });

  it("formats low speedups with 2 decimals", () => {
    expect(formatSpeedup(3.456)).toBe("3.46x faster");
    expect(formatSpeedup(1.5)).toBe("1.50x faster");
  });

  it("returns 'about the same speed' for near-1x speedups", () => {
    expect(formatSpeedup(1.0)).toBe("about the same speed");
    expect(formatSpeedup(1.04)).toBe("about the same speed");
  });

  it("formats speedups just above threshold", () => {
    expect(formatSpeedup(1.05)).toBe("1.05x faster");
  });

  it("returns dash for invalid values", () => {
    expect(formatSpeedup(0)).toBe("-");
    expect(formatSpeedup(-1)).toBe("-");
    expect(formatSpeedup(NaN)).toBe("-");
    expect(formatSpeedup(Infinity)).toBe("-");
  });
});

// ── Constants ─────────────────────────────────────────────────────────────

describe("constants", () => {
  it("exports BENCHMARK_AUDIO_DURATION_SEC as 10", () => {
    expect(BENCHMARK_AUDIO_DURATION_SEC).toBe(10);
  });
});
