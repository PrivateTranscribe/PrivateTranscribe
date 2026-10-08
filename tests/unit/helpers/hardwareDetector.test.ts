import { describe, it, expect, vi } from "vitest";

/**
 * Tests for HardwareDetector.generateRecommendations()
 *
 * generateRecommendations is a synchronous pure-logic method, so we test it
 * by instantiating HardwareDetector and calling it directly with synthetic
 * detection objects — no Electron, no GPU drivers, no file system.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const HardwareDetector = require("../../../src/helpers/hardwareDetector");

function makeDetection(overrides: Record<string, unknown> = {}) {
  return {
    gpu: {
      available: false,
      vendor: null,
      model: null,
      vram: null,
      cuda: { available: false, version: null },
      metal: { available: false, version: null },
    },
    cpu: { count: 8, model: "Test CPU", speed: 3000 },
    ...overrides,
  };
}

describe("HardwareDetector.generateRecommendations", () => {
  let detector: { generateRecommendations: (d: unknown) => Record<string, unknown> };

  beforeEach(() => {
    detector = new HardwareDetector();
  });

  // ── Default / CPU-only paths ─────────────────────────────────────────────

  describe("CPU-only (no GPU)", () => {
    // os.cpus().length is logical threads, so 8 "cores" is often a 4-core/8-thread
    // CPU. Turbo/Large are GPU-class models; the CPU path must never pick them.
    it("never recommends turbo or large on the CPU path (8 threads)", () => {
      const rec = detector.generateRecommendations(makeDetection({ cpu: { count: 8 } }));
      expect(rec.whisperModel).not.toBe("turbo");
      expect(rec.whisperModel).not.toBe("large");
      expect(rec.whisperModel).toBe("base");
      expect(rec.localTranscriptionProvider).toBe("whisper");
    });

    it("recommends small (not turbo) for very high thread counts", () => {
      const rec = detector.generateRecommendations(makeDetection({ cpu: { count: 16 } }));
      expect(rec.whisperModel).toBe("small");
    });

    it("recommends base for quad-core CPUs", () => {
      const rec = detector.generateRecommendations(makeDetection({ cpu: { count: 4 } }));
      expect(rec.whisperModel).toBe("base");
      expect(rec.localTranscriptionProvider).toBe("whisper");
    });

    it("recommends tiny for low-core CPUs (< 4 threads)", () => {
      const rec = detector.generateRecommendations(makeDetection({ cpu: { count: 2 } }));
      expect(rec.whisperModel).toBe("tiny");
    });
  });

  // ── NVIDIA + CUDA ────────────────────────────────────────────────────────

  describe("NVIDIA GPU with CUDA", () => {
    function nvidiaDetection(vram: number | null = 4096, model = "RTX 3080") {
      return makeDetection({
        gpu: {
          available: true,
          vendor: "nvidia",
          model,
          vram,
          cuda: { available: true, version: "12.0" },
          metal: { available: false, version: null },
        },
      });
    }

    it("recommends Whisper (not Parakeet) for CUDA-capable GPUs", () => {
      const rec = detector.generateRecommendations(nvidiaDetection());
      expect(rec.localTranscriptionProvider).toBe("whisper");
      expect(rec.parakeetModel).toBeUndefined();
      expect(rec.transcriptionProvider).toBe("local");
    });

    it("includes graphics memory reasoning when VRAM >= 4GB", () => {
      const rec = detector.generateRecommendations(nvidiaDetection(4096));
      expect(rec.reasoning).toEqual(
        expect.arrayContaining([expect.stringContaining("plenty for local transcription")])
      );
    });

    it("does not include the 'plenty for local transcription' reasoning when VRAM < 4GB", () => {
      const rec = detector.generateRecommendations(nvidiaDetection(2048));
      const hasExcellentReasoning = (rec.reasoning as string[]).some((r) =>
        r.includes("plenty for local transcription")
      );
      expect(hasExcellentReasoning).toBe(false);
    });

    it("does not recommend Parakeet when CUDA is absent (NVIDIA but no CUDA)", () => {
      const detection = makeDetection({
        gpu: {
          available: true,
          vendor: "nvidia",
          model: "Old Card",
          vram: 2048,
          cuda: { available: false, version: null },
          metal: { available: false, version: null },
        },
      });
      const rec = detector.generateRecommendations(detection);
      expect(rec.localTranscriptionProvider).toBe("whisper");
    });

    it("recommends Whisper Large for high-VRAM CUDA GPUs like RTX 3090", () => {
      const rec = detector.generateRecommendations(
        nvidiaDetection(24576, "NVIDIA GeForce RTX 3090")
      );

      expect(rec.whisperModel).toBe("large");
      expect(rec.reasoning as string[]).toEqual(
        expect.arrayContaining([expect.stringContaining("Large")])
      );
      expect(rec.reasoning as string[]).toEqual(
        expect.arrayContaining([expect.stringContaining("24.0 GB")])
      );
    });
  });

  // ── Metal / macOS ────────────────────────────────────────────────────────

  describe("Apple Silicon / Metal GPU", () => {
    function metalDetection(vendor = "apple") {
      return makeDetection({
        gpu: {
          available: true,
          vendor,
          model: "Apple M2",
          vram: null,
          cuda: { available: false, version: null },
          metal: { available: true, version: "3.1" },
        },
      });
    }

    it("recommends whisper (not Parakeet) for Metal GPUs", () => {
      const rec = detector.generateRecommendations(metalDetection());
      expect(rec.localTranscriptionProvider).toBe("whisper");
    });

    it("recommends small model for Apple Silicon", () => {
      const rec = detector.generateRecommendations(metalDetection("apple"));
      expect(rec.whisperModel).toBe("small");
    });

    it("includes Metal acceleration reasoning", () => {
      const rec = detector.generateRecommendations(metalDetection());
      expect(rec.reasoning).toEqual(expect.arrayContaining([expect.stringContaining("Metal")]));
    });
  });

  // ── Null/missing hardware ─────────────────────────────────────────────────

  describe("missing / null hardware data", () => {
    it("returns safe defaults when gpu/cpu are missing", () => {
      const rec = detector.generateRecommendations({ gpu: null, cpu: null });
      expect(rec.localTranscriptionProvider).toBe("whisper");
      expect(rec.transcriptionProvider).toBe("local");
      expect(rec.reasoning.length).toBeGreaterThan(0);
    });

    it("default whisperModel is base, not turbo, when the hardware is unknown", () => {
      // The safe-default branch returns early before any path-specific override.
      // Turbo is the slowest model on a CPU, so it cannot be the blind default.
      const rec = detector.generateRecommendations({ gpu: null, cpu: null });
      expect(rec.whisperModel).toBe("base");
    });

    it("marks Parakeet hardware as not eligible when detection failed", () => {
      const rec = detector.generateRecommendations({ gpu: null, cpu: null });
      expect(rec.parakeetHardware).toEqual({
        eligible: false,
        reasons: ["Could not check this PC's hardware."],
      });
    });
  });

  // ── Parakeet hardware eligibility on every category ──────────────────────

  describe("parakeetHardware", () => {
    const GIB = 1024 ** 3;
    const strongCpu = { count: 16, physicalCores: 8, avx2: true };
    const memory = { totalBytes: 16 * GIB };

    const gpus: Record<string, Record<string, unknown>> = {
      cpu_only: {
        available: false,
        vendor: null,
        cuda: { available: false },
        metal: { available: false },
      },
      nvidia_cuda: {
        available: true,
        vendor: "nvidia",
        model: "RTX 4070",
        vram: 12288,
        cuda: { available: true },
        metal: { available: false },
      },
      nvidia_no_cuda: {
        available: true,
        vendor: "nvidia",
        model: "GTX 970",
        vram: 4096,
        cuda: { available: false },
        metal: { available: false },
      },
      non_nvidia_gpu: {
        available: true,
        vendor: "amd",
        model: "Radeon RX 6800",
        vram: 16384,
        cuda: { available: false },
        metal: { available: false },
      },
      metal: {
        available: true,
        vendor: "apple",
        model: "Apple M2",
        cuda: { available: false },
        metal: { available: true, version: "3.1" },
      },
    };

    it.each(Object.keys(gpus))("is computed for the %s category", (category) => {
      const rec = detector.generateRecommendations(
        makeDetection({ gpu: gpus[category], cpu: strongCpu, memory })
      );
      expect(rec.gpuCategory).toBe(category);
      expect(rec.parakeetHardware).toEqual({ eligible: true, reasons: [] });
    });

    it("keeps GPU Whisper as the CUDA default even when Parakeet qualifies", () => {
      const rec = detector.generateRecommendations(
        makeDetection({ gpu: gpus.nvidia_cuda, cpu: strongCpu, memory })
      );
      expect(rec.localTranscriptionProvider).toBe("whisper");
      expect(rec.whisperModel).toBe("large");
    });

    it("carries the failed rules from the detected hardware", () => {
      const rec = detector.generateRecommendations(
        makeDetection({
          cpu: { count: 4, physicalCores: 2, avx2: false },
          memory: { totalBytes: 4 * GIB },
        })
      );
      expect(rec.parakeetHardware).toEqual({
        eligible: false,
        reasons: [
          "Needs a processor with at least 4 cores. This PC has 2.",
          "Needs a newer processor (AVX2 support).",
          "Needs 8 GB of memory. This PC has 4 GB.",
        ],
      });
    });

    it("does not change the Whisper recommendation or reasoning", () => {
      const without = detector.generateRecommendations(makeDetection({ cpu: { count: 8 } }));
      const withFacts = detector.generateRecommendations(
        makeDetection({ cpu: { count: 8, physicalCores: 4, avx2: true }, memory })
      );
      expect(withFacts.whisperModel).toBe(without.whisperModel);
      expect(withFacts.reasoning).toEqual(without.reasoning);
    });
  });

  // ── Invariant: always returns required fields ─────────────────────────────

  describe("output shape invariants", () => {
    const scenarios = [
      { label: "CPU-only 8 cores", detection: makeDetection({ cpu: { count: 8 } }) },
      { label: "CPU-only 4 cores", detection: makeDetection({ cpu: { count: 4 } }) },
      {
        label: "NVIDIA CUDA",
        detection: makeDetection({
          gpu: {
            available: true,
            vendor: "nvidia",
            cuda: { available: true },
            metal: { available: false },
          },
        }),
      },
    ];

    scenarios.forEach(({ label, detection }) => {
      it(`always returns transcriptionProvider, localTranscriptionProvider, reasoning for: ${label}`, () => {
        const rec = detector.generateRecommendations(detection);
        expect(rec).toHaveProperty("transcriptionProvider");
        expect(rec).toHaveProperty("localTranscriptionProvider");
        expect(Array.isArray(rec.reasoning)).toBe(true);
        expect((rec.reasoning as string[]).length).toBeGreaterThan(0);
      });
    });
  });

  // ── gpuCategory classification ────────────────────────────────────────────

  describe("gpuCategory classification", () => {
    it("nvidia_cuda for NVIDIA + CUDA", () => {
      const rec = detector.generateRecommendations(
        makeDetection({
          gpu: {
            available: true,
            vendor: "nvidia",
            model: "RTX 4080",
            vram: 16384,
            cuda: { available: true, version: "12.3" },
            metal: { available: false, version: null },
          },
        })
      );
      expect(rec.gpuCategory).toBe("nvidia_cuda");
    });

    it("nvidia_no_cuda for NVIDIA GPU without CUDA runtime", () => {
      const rec = detector.generateRecommendations(
        makeDetection({
          gpu: {
            available: true,
            vendor: "nvidia",
            model: "GTX 1050",
            vram: 4096,
            cuda: { available: false, version: null },
            metal: { available: false, version: null },
          },
        })
      );
      expect(rec.gpuCategory).toBe("nvidia_no_cuda");
    });

    it("non_nvidia_gpu for AMD GPU", () => {
      const rec = detector.generateRecommendations(
        makeDetection({
          gpu: {
            available: true,
            vendor: "amd",
            model: "Radeon RX 6800",
            vram: 16384,
            cuda: { available: false, version: null },
            metal: { available: false, version: null },
          },
        })
      );
      expect(rec.gpuCategory).toBe("non_nvidia_gpu");
    });

    it("non_nvidia_gpu for Intel GPU", () => {
      const rec = detector.generateRecommendations(
        makeDetection({
          gpu: {
            available: true,
            vendor: "intel",
            model: "Intel Arc A770",
            vram: 16384,
            cuda: { available: false, version: null },
            metal: { available: false, version: null },
          },
        })
      );
      expect(rec.gpuCategory).toBe("non_nvidia_gpu");
    });

    it("cpu_only when no GPU detected", () => {
      const rec = detector.generateRecommendations(makeDetection({ cpu: { count: 8 } }));
      expect(rec.gpuCategory).toBe("cpu_only");
    });

    it("metal for Apple Silicon GPU", () => {
      const rec = detector.generateRecommendations(
        makeDetection({
          gpu: {
            available: true,
            vendor: "apple",
            model: "Apple M2",
            vram: null,
            cuda: { available: false, version: null },
            metal: { available: true, version: "3.1" },
          },
        })
      );
      expect(rec.gpuCategory).toBe("metal");
    });

    it("cpu_only for null hardware data", () => {
      const rec = detector.generateRecommendations({ gpu: null, cpu: null });
      expect(rec.gpuCategory).toBe("cpu_only");
    });
  });

  // ── NVIDIA-no-CUDA recovery steps ─────────────────────────────────────────

  describe("NVIDIA GPU without CUDA — recovery steps", () => {
    function nvidiaNocudaDetection() {
      return makeDetection({
        gpu: {
          available: true,
          vendor: "nvidia",
          model: "GTX 970",
          vram: 4096,
          cuda: { available: false, version: null },
          metal: { available: false, version: null },
        },
      });
    }

    it("provides non-empty recoverySteps for nvidia_no_cuda", () => {
      const rec = detector.generateRecommendations(nvidiaNocudaDetection());
      expect(Array.isArray(rec.recoverySteps)).toBe(true);
      expect((rec.recoverySteps as string[]).length).toBeGreaterThan(0);
    });

    it("recovery steps mention drivers or CUDA", () => {
      const rec = detector.generateRecommendations(nvidiaNocudaDetection());
      const combined = (rec.recoverySteps as string[]).join(" ").toLowerCase();
      expect(combined).toMatch(/driver|cuda/);
    });

    it("falls back to Whisper (not Parakeet) for nvidia_no_cuda", () => {
      const rec = detector.generateRecommendations(nvidiaNocudaDetection());
      expect(rec.localTranscriptionProvider).toBe("whisper");
      expect(rec.parakeetModel).toBeUndefined();
    });

    it("includes GPU name in reasoning for nvidia_no_cuda", () => {
      const rec = detector.generateRecommendations(nvidiaNocudaDetection());
      const combined = (rec.reasoning as string[]).join(" ");
      expect(combined).toContain("GTX 970");
    });

    it("recoverySteps is empty for nvidia_cuda (no recovery needed)", () => {
      const rec = detector.generateRecommendations(
        makeDetection({
          gpu: {
            available: true,
            vendor: "nvidia",
            model: "RTX 3080",
            vram: 10240,
            cuda: { available: true, version: "12.0" },
            metal: { available: false, version: null },
          },
        })
      );
      expect((rec.recoverySteps as string[]).length).toBe(0);
    });

    it("recoverySteps is empty for cpu_only", () => {
      const rec = detector.generateRecommendations(makeDetection({ cpu: { count: 8 } }));
      expect((rec.recoverySteps as string[]).length).toBe(0);
    });
  });

  // ── Non-NVIDIA GPU messaging ──────────────────────────────────────────────

  describe("non-NVIDIA GPU messaging", () => {
    it("mentions vendor name in AMD GPU reasoning", () => {
      const rec = detector.generateRecommendations(
        makeDetection({
          gpu: {
            available: true,
            vendor: "amd",
            model: "Radeon RX 7900",
            vram: 24576,
            cuda: { available: false, version: null },
            metal: { available: false, version: null },
          },
        })
      );
      const combined = (rec.reasoning as string[]).join(" ");
      expect(combined).toMatch(/AMD/i);
    });

    it("non-NVIDIA GPU uses Whisper (CPU path), not Parakeet", () => {
      const rec = detector.generateRecommendations(
        makeDetection({
          gpu: {
            available: true,
            vendor: "amd",
            model: "Radeon RX 7900",
            vram: 24576,
            cuda: { available: false, version: null },
            metal: { available: false, version: null },
          },
        })
      );
      expect(rec.localTranscriptionProvider).toBe("whisper");
      expect(rec.gpuCategory).toBe("non_nvidia_gpu");
    });
  });
});

// ── parseVRAM ──────────────────────────────────────────────────────────────

describe("HardwareDetector.parseVRAM", () => {
  let detector: { parseVRAM: (v: unknown) => number | null };

  beforeEach(() => {
    detector = new HardwareDetector();
  });

  it("parses '8192 MiB' → 8192", () => {
    expect(detector.parseVRAM("8192 MiB")).toBe(8192);
  });

  it("parses '8 GiB' → 8192", () => {
    expect(detector.parseVRAM("8 GiB")).toBe(8192);
  });

  it("parses '8 GB' → 8192", () => {
    expect(detector.parseVRAM("8 GB")).toBe(8192);
  });

  it("parses '10,240 MiB' (comma separator) → 10240", () => {
    expect(detector.parseVRAM("10,240 MiB")).toBe(10240);
  });

  it("parses pure byte string (WMIC style) → MiB", () => {
    // 8 GiB in bytes = 8 * 1024 * 1024 * 1024 = 8589934592
    expect(detector.parseVRAM("8589934592")).toBe(8192);
  });

  it("parses numeric bytes (number type) → MiB", () => {
    expect(detector.parseVRAM(8589934592)).toBe(8192);
  });

  it("returns null for null input", () => {
    expect(detector.parseVRAM(null)).toBeNull();
  });

  it("returns null for undefined input", () => {
    expect(detector.parseVRAM(undefined)).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(detector.parseVRAM("")).toBeNull();
  });

  it("returns null for non-numeric string", () => {
    expect(detector.parseVRAM("no vram")).toBeNull();
  });

  it("parses '4096 MB' → 4096", () => {
    expect(detector.parseVRAM("4096 MB")).toBe(4096);
  });

  it("passes through small integer values (already MiB)", () => {
    // Values <= 16 * 1024 * 1024 (16 TiB) are treated as MiB
    expect(detector.parseVRAM(4096)).toBe(4096);
  });
});

// ── getVendorDisplayName ───────────────────────────────────────────────────

describe("HardwareDetector.getVendorDisplayName", () => {
  let detector: { getVendorDisplayName: (v: string) => string };

  beforeEach(() => {
    detector = new HardwareDetector();
  });

  it("returns 'NVIDIA' for 'nvidia'", () => {
    expect(detector.getVendorDisplayName("nvidia")).toBe("NVIDIA");
  });

  it("returns 'AMD' for 'amd' (not 'Amd')", () => {
    expect(detector.getVendorDisplayName("amd")).toBe("AMD");
  });

  it("returns 'Intel' for 'intel'", () => {
    expect(detector.getVendorDisplayName("intel")).toBe("Intel");
  });

  it("returns 'Apple' for 'apple'", () => {
    expect(detector.getVendorDisplayName("apple")).toBe("Apple");
  });

  it("returns 'Unknown' for 'unknown'", () => {
    expect(detector.getVendorDisplayName("unknown")).toBe("Unknown");
  });

  it("non-NVIDIA AMD GPU uses AMD display name in reasoning", () => {
    const genRec = new HardwareDetector();
    const rec = genRec.generateRecommendations(
      makeDetection({
        gpu: {
          available: true,
          vendor: "amd",
          model: "Radeon RX 7900",
          vram: 24576,
          cuda: { available: false, version: null },
          metal: { available: false, version: null },
        },
      })
    );
    // Must be "AMD", not "Amd"
    expect((rec.reasoning as string[]).join(" ")).toContain("AMD");
    expect((rec.reasoning as string[]).join(" ")).not.toMatch(/\bAmd\b/);
  });
});

// ── VRAM display in reasoning ──────────────────────────────────────────────

describe("VRAM display in NVIDIA CUDA reasoning", () => {
  let detector: { generateRecommendations: (d: unknown) => Record<string, unknown> };

  beforeEach(() => {
    detector = new HardwareDetector();
  });

  it("shows GB notation for VRAM >= 1024 MiB", () => {
    const rec = detector.generateRecommendations(
      makeDetection({
        gpu: {
          available: true,
          vendor: "nvidia",
          model: "RTX 4090",
          vram: 24576, // 24 GiB
          cuda: { available: true, version: "12.3" },
          metal: { available: false, version: null },
        },
      })
    );
    const combined = (rec.reasoning as string[]).join(" ");
    expect(combined).toMatch(/\d+(\.\d+)?\s*GB/);
    expect(combined).not.toMatch(/24576\s*MB/);
  });

  it("VRAM reasoning includes 'GB' for 4096 MiB (4 GB)", () => {
    const rec = detector.generateRecommendations(
      makeDetection({
        gpu: {
          available: true,
          vendor: "nvidia",
          model: "RTX 3080",
          vram: 4096,
          cuda: { available: true, version: "12.0" },
          metal: { available: false, version: null },
        },
      })
    );
    const combined = (rec.reasoning as string[]).join(" ");
    expect(combined).toContain("4.0 GB");
  });
});

describe("HardwareDetector.detectHardware", () => {
  it("shares one in-flight hardware scan between concurrent callers", async () => {
    const detector = new HardwareDetector();
    let calls = 0;
    detector.buildDetection = async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return makeDetection({ timestamp: Date.now(), platform: "test", arch: "x64" });
    };

    const [first, second] = await Promise.all([
      detector.detectHardware(),
      detector.detectHardware(),
    ]);

    expect(calls).toBe(1);
    expect(first).toBe(second);
    expect(await detector.detectHardware()).toBe(first);
    expect(calls).toBe(1);
  });

  it("clears both cached and in-flight detections when re-detecting", async () => {
    const detector = new HardwareDetector();
    detector.detectionPromise = Promise.resolve(makeDetection());

    detector.clearCache();

    expect(detector.cachedDetection).toBeNull();
    expect(detector.detectionPromise).toBeNull();
  });
});

// ── evaluateParakeetHardware ───────────────────────────────────────────────

describe("evaluateParakeetHardware", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { evaluateParakeetHardware } = require("../../../src/helpers/parakeetEligibility");
  const GIB = 1024 ** 3;
  const passing = { physicalCores: 8, avx2: true, totalBytes: 16 * GIB };

  it("passes a machine that meets every rule", () => {
    expect(evaluateParakeetHardware(passing)).toEqual({ eligible: true, reasons: [] });
  });

  it("passes at exactly 4 physical cores and fails at 3", () => {
    expect(evaluateParakeetHardware({ ...passing, physicalCores: 4 }).eligible).toBe(true);
    expect(evaluateParakeetHardware({ ...passing, physicalCores: 3 })).toEqual({
      eligible: false,
      reasons: ["Needs a processor with at least 4 cores. This PC has 3."],
    });
  });

  it("passes at exactly 7.5 GiB and fails one byte under", () => {
    expect(evaluateParakeetHardware({ ...passing, totalBytes: 7.5 * GIB }).eligible).toBe(true);
    expect(evaluateParakeetHardware({ ...passing, totalBytes: 7.5 * GIB - 1 })).toEqual({
      eligible: false,
      reasons: ["Needs 8 GB of memory. This PC has 7.4 GB."],
    });
  });

  it("passes a typical 8 GB laptop that reports 7.8 GiB", () => {
    expect(evaluateParakeetHardware({ ...passing, totalBytes: 7.8 * GIB }).eligible).toBe(true);
  });

  it("names the memory in whole or one-decimal gigabytes", () => {
    expect(evaluateParakeetHardware({ ...passing, totalBytes: 4 * GIB }).reasons).toEqual([
      "Needs 8 GB of memory. This PC has 4 GB.",
    ]);
    expect(evaluateParakeetHardware({ ...passing, totalBytes: 3.8 * GIB }).reasons).toEqual([
      "Needs 8 GB of memory. This PC has 3.8 GB.",
    ]);
  });

  it("passes when AVX2 is unknown and fails only when it is known to be missing", () => {
    expect(evaluateParakeetHardware({ ...passing, avx2: null }).eligible).toBe(true);
    expect(evaluateParakeetHardware({ ...passing, avx2: false })).toEqual({
      eligible: false,
      reasons: ["Needs a newer processor (AVX2 support)."],
    });
  });

  it("falls back to half the logical count, rounded down, without a physical count", () => {
    const base = { ...passing, physicalCores: null };
    expect(evaluateParakeetHardware({ ...base, logicalCores: 8 }).eligible).toBe(true);
    expect(evaluateParakeetHardware({ ...base, logicalCores: 7 })).toEqual({
      eligible: false,
      reasons: ["Needs a processor with at least 4 cores. This PC has 3."],
    });
  });

  it("fails the core rule with its own sentence when no count is known at all", () => {
    expect(
      evaluateParakeetHardware({ ...passing, physicalCores: null, logicalCores: null })
    ).toEqual({ eligible: false, reasons: ["Could not count this PC's processor cores."] });
  });

  it("treats unknown memory as passing", () => {
    expect(evaluateParakeetHardware({ ...passing, totalBytes: null }).eligible).toBe(true);
    expect(evaluateParakeetHardware({ ...passing, totalBytes: 0 }).eligible).toBe(true);
  });

  it("lists every failed rule, one sentence each", () => {
    const result = evaluateParakeetHardware({ physicalCores: 2, avx2: false, totalBytes: 4 * GIB });
    expect(result.eligible).toBe(false);
    expect(result.reasons).toHaveLength(3);
  });
});

// ── buildDetection: the new hardware facts ─────────────────────────────────

describe("HardwareDetector.buildDetection hardware facts", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const cpuFeatures = require("../../../src/helpers/cpuFeatures");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const cpuThreads = require("../../../src/helpers/cpuThreads");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require("os");

  const noGpu = {
    available: false,
    vendor: null,
    model: null,
    vram: null,
    cuda: { available: false, version: null },
    metal: { available: false, version: null },
    directml: { available: false },
    rocm: { available: false, version: null },
  };

  function stubProbes({
    cores = 8 as unknown,
    avx2 = true as unknown,
    gpuDelayMs = 0,
  }: { cores?: unknown; avx2?: unknown; gpuDelayMs?: number } = {}) {
    const events: string[] = [];
    vi.spyOn(cpuThreads, "warmCpuTopology").mockImplementation(async () => {
      events.push("cores");
      if (cores instanceof Error) throw cores;
      return cores;
    });
    vi.spyOn(cpuFeatures, "detectAvx2").mockImplementation(async () => {
      events.push("avx2");
      if (avx2 instanceof Error) throw avx2;
      return avx2;
    });
    vi.spyOn(HardwareDetector.prototype, "detectGPU").mockImplementation(async () => {
      events.push("gpu:start");
      await new Promise((resolve) => setTimeout(resolve, gpuDelayMs));
      events.push("gpu:end");
      return { ...noGpu };
    });
    return events;
  }

  it("adds physicalCores, avx2, memory and parakeetHardware to the result", async () => {
    stubProbes({ cores: 8, avx2: true });
    const detection = await new HardwareDetector().buildDetection();

    expect(detection.cpu.physicalCores).toBe(8);
    expect(detection.cpu.avx2).toBe(true);
    expect(detection.cpu.count).toBe(os.cpus().length);
    expect(detection.memory).toEqual({ totalBytes: os.totalmem() });
    expect(detection.recommendations.parakeetHardware).toHaveProperty("eligible");
    expect(Array.isArray(detection.recommendations.parakeetHardware.reasons)).toBe(true);
  });

  it("starts the CPU probes before GPU detection finishes", async () => {
    const events = stubProbes({ gpuDelayMs: 20 });
    await new HardwareDetector().buildDetection();

    expect(events.indexOf("cores")).toBeLessThan(events.indexOf("gpu:end"));
    expect(events.indexOf("avx2")).toBeLessThan(events.indexOf("gpu:end"));
  });

  it("reports null for probes that fail or return nonsense, without throwing", async () => {
    stubProbes({ cores: new Error("probe failed"), avx2: new Error("probe failed") });
    const failed = await new HardwareDetector().buildDetection();
    expect(failed.cpu.physicalCores).toBeNull();
    expect(failed.cpu.avx2).toBeNull();

    vi.restoreAllMocks();
    stubProbes({ cores: 0, avx2: null });
    const nonsense = await new HardwareDetector().buildDetection();
    expect(nonsense.cpu.physicalCores).toBeNull();
    expect(nonsense.cpu.avx2).toBeNull();
  });

  it("feeds the detected facts into the eligibility check", async () => {
    stubProbes({ cores: 2, avx2: false });
    const detection = await new HardwareDetector().buildDetection();
    const { reasons, eligible } = detection.recommendations.parakeetHardware;

    expect(eligible).toBe(false);
    expect(reasons).toContain("Needs a processor with at least 4 cores. This PC has 2.");
    expect(reasons).toContain("Needs a newer processor (AVX2 support).");
  });
});
