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
});
