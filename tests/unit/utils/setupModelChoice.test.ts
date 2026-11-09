import { describe, it, expect } from "vitest";
import {
  cpuModelForThreads,
  isHeavyOnCpu,
  pickSetupWhisperModel,
} from "../../../src/utils/setupModelChoice";

/**
 * Setup's model pick follows the engine and the spoken language. The hardware
 * detector alone handed a Danish speaker on a laptop Whisper Base, which gets
 * most Danish words wrong.
 */
describe("pickSetupWhisperModel", () => {
  const laptop = { detectorModel: "base", cpuThreads: 8, vramMb: null };

  it("keeps the detector's processor model for English", () => {
    const choice = pickSetupWhisperModel({ ...laptop, engine: "cpu", ratingLanguage: "en" });
    expect(choice.model).toBe("base");
    expect(choice.slowOnThisEngine).toBe(false);
  });

  it("treats auto-detect like English, since no language was named", () => {
    expect(pickSetupWhisperModel({ ...laptop, engine: "cpu", ratingLanguage: "auto" }).model).toBe(
      "base"
    );
  });

  it("gives a Danish speaker on the processor Turbo and says it is slow", () => {
    const choice = pickSetupWhisperModel({ ...laptop, engine: "cpu", ratingLanguage: "da" });
    expect(choice.model).toBe("turbo");
    expect(choice.slowOnThisEngine).toBe(true);
    expect(choice.reason).toContain("Danish");
    expect(choice.reason).toMatch(/slow/i);
  });

  it("falls back from a GPU pick to a processor model when the GPU fails (English)", () => {
    const choice = pickSetupWhisperModel({
      engine: "cpu",
      detectorModel: "large",
      cpuThreads: 16,
      vramMb: 24576,
      ratingLanguage: "en",
    });
    expect(choice.model).toBe("small");
  });

  it("falls back from Large to Turbo, not Base, for Danish when the GPU fails", () => {
    const choice = pickSetupWhisperModel({
      engine: "cpu",
      detectorModel: "large",
      cpuThreads: 16,
      vramMb: 24576,
      ratingLanguage: "da",
    });
    expect(choice.model).toBe("turbo");
  });

  it("keeps the detector's GPU model for a big card", () => {
    const choice = pickSetupWhisperModel({
      engine: "gpu",
      detectorModel: "large",
      cpuThreads: 16,
      vramMb: 24576,
      ratingLanguage: "da",
    });
    expect(choice.model).toBe("large");
    expect(choice.slowOnThisEngine).toBe(false);
  });

  it("lifts a 4 GB card from Small to Turbo for Danish, not for English", () => {
    const card = { engine: "gpu" as const, detectorModel: "small", cpuThreads: 8, vramMb: 4096 };
    expect(pickSetupWhisperModel({ ...card, ratingLanguage: "da" }).model).toBe("turbo");
    expect(pickSetupWhisperModel({ ...card, ratingLanguage: "en" }).model).toBe("small");
  });

  it("leaves a card under 4 GB on the detector's pick", () => {
    expect(
      pickSetupWhisperModel({
        engine: "gpu",
        detectorModel: "base",
        cpuThreads: 8,
        vramMb: 2048,
        ratingLanguage: "da",
      }).model
    ).toBe("base");
  });
});

describe("cpuModelForThreads", () => {
  it("mirrors the detector's processor rule", () => {
    expect(cpuModelForThreads(32)).toBe("small");
    expect(cpuModelForThreads(8)).toBe("base");
    expect(cpuModelForThreads(2)).toBe("tiny");
    expect(cpuModelForThreads(null)).toBe("base");
  });
});

describe("isHeavyOnCpu", () => {
  it("flags the models a processor runs at or slower than speech", () => {
    expect(isHeavyOnCpu("large")).toBe(true);
    expect(isHeavyOnCpu("turbo")).toBe(true);
    expect(isHeavyOnCpu("base")).toBe(false);
  });
});
