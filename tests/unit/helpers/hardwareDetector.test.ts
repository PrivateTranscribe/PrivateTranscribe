import { describe, it, expect } from "vitest";

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
    it("recommends turbo for 8+ core CPUs", () => {
      const rec = detector.generateRecommendations(makeDetection({ cpu: { count: 8 } }));
      expect(rec.whisperModel).toBe("turbo");
      expect(rec.localTranscriptionProvider).toBe("whisper");
    });

    it("recommends turbo for 16-core CPUs", () => {
      const rec = detector.generateRecommendations(makeDetection({ cpu: { count: 16 } }));
      expect(rec.whisperModel).toBe("turbo");
    });

    it("recommends base for quad-core CPUs", () => {
      const rec = detector.generateRecommendations(makeDetection({ cpu: { count: 4 } }));
      expect(rec.whisperModel).toBe("base");
      expect(rec.localTranscriptionProvider).toBe("whisper");
    });

    it("recommends tiny for low-core CPUs (< 4 cores)", () => {
      const rec = detector.generateRecommendations(makeDetection({ cpu: { count: 2 } }));
      expect(rec.whisperModel).toBe("tiny");
    });
  });

  // ── NVIDIA + CUDA ────────────────────────────────────────────────────────

  describe("NVIDIA GPU with CUDA", () => {
    function nvidiaDetection(vram: number | null = 4096) {
      return makeDetection({
        gpu: {
          available: true,
          vendor: "nvidia",
          model: "RTX 3080",
          vram,
          cuda: { available: true, version: "12.0" },
          metal: { available: false, version: null },
        },
      });
    }

    it("recommends Parakeet (nvidia) for CUDA-capable GPUs", () => {
      const rec = detector.generateRecommendations(nvidiaDetection());
      expect(rec.localTranscriptionProvider).toBe("nvidia");
      expect(rec.parakeetModel).toBe("parakeet-tdt-0.6b-v3");
      expect(rec.transcriptionProvider).toBe("local");
    });

    it("includes VRAM reasoning when VRAM >= 4GB", () => {
      const rec = detector.generateRecommendations(nvidiaDetection(4096));
      expect(rec.reasoning).toEqual(expect.arrayContaining([expect.stringContaining("VRAM")]));
    });

    it("does not include VRAM reasoning when VRAM < 4GB", () => {
      const rec = detector.generateRecommendations(nvidiaDetection(2048));
      const hasVramReasoning = (rec.reasoning as string[]).some((r) => r.includes("VRAM"));
      expect(hasVramReasoning).toBe(false);
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

    it("default whisperModel is turbo (the baseline before path-specific overrides)", () => {
      // When no GPU and no CPU info, we still get a valid recommendation object
      const rec = detector.generateRecommendations({ gpu: null, cpu: null });
      // The safe-default branch returns early before overriding whisperModel,
      // so it should be the constructor default "turbo"
      expect(rec.whisperModel).toBe("turbo");
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
