const HardwareDetector = require("../src/helpers/hardwareDetector");

describe("HardwareDetector.generateRecommendations", () => {
  it("never returns null and provides safe defaults when cpu/gpu are missing", () => {
    const detector = new HardwareDetector();

    const rec = detector.generateRecommendations({ cpu: null, gpu: null });

    expect(rec).toBeTruthy();
    expect(rec.transcriptionProvider).toBe("local");
    expect(rec.localTranscriptionProvider).toBe("whisper");
    expect(rec.whisperModel).toBe("base");
    expect(rec.parakeetHardware).toEqual({
      eligible: false,
      reasons: ["Could not check this PC's hardware."],
    });
    expect(Array.isArray(rec.reasoning)).toBe(true);
    expect(rec.reasoning.length).toBeGreaterThan(0);
  });

  it("recommends Whisper (not Parakeet) when NVIDIA CUDA is available", () => {
    const detector = new HardwareDetector();

    const rec = detector.generateRecommendations({
      cpu: { count: 8, model: "Test CPU", speed: 0 },
      gpu: {
        available: true,
        vendor: "nvidia",
        model: "NVIDIA RTX Test",
        vram: 8192,
        cuda: { available: true, version: "12.0" },
        metal: { available: false, version: null },
      },
    });

    expect(rec).toBeTruthy();
    expect(rec.transcriptionProvider).toBe("local");
    expect(rec.localTranscriptionProvider).toBe("whisper");
    expect(rec.parakeetModel).toBeUndefined();
    expect(rec.reasoning.length).toBeGreaterThan(0);
  });
});
