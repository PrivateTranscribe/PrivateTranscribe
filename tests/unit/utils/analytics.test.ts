import { describe, expect, it } from "vitest";
import {
  buildTranscriptionAnalyticsProperties,
  computeRealtimeFactorX100,
} from "../../../src/utils/analytics";

describe("transcription analytics properties", () => {
  it("returns privacy-safe usage and exact performance properties without transcript content", () => {
    const privateText = "Discuss the confidential acquisition timeline with the legal team";
    const properties = buildTranscriptionAnalyticsProperties({
      source: "local",
      outputAction: "paste",
      text: privateText,
      durationSeconds: 12,
      preferredLanguage: "da",
      model: "turbo",
      computeMode: "cuda",
      transcriptionProcessingDurationMs: 400,
    });

    // Exhaustive on purpose: every field leaving the device is listed here, so
    // adding one has to be a deliberate edit to this test.
    expect(properties).toEqual({
      source: "local",
      output_action: "paste",
      word_count_bucket: "1-10",
      duration_bucket: "6-15s",
      language: "da",
      model: "turbo",
      compute_mode: "cuda",
      realtime_factor_x100: 3000,
    });
    expect(JSON.stringify(properties)).not.toContain(privateText);
    expect(properties).not.toHaveProperty("text");
    expect(properties).not.toHaveProperty("processing_ms");
  });

  it("reports exact hundredths of real-time speed rather than a bucket", () => {
    expect(computeRealtimeFactorX100(12, 400)).toBe(3000);
    expect(computeRealtimeFactorX100(10, 333)).toBe(3003);
    expect(computeRealtimeFactorX100(0, 400)).toBeNull();
    expect(computeRealtimeFactorX100(12, Number.NaN)).toBeNull();
  });

  it("omits speed when timing is unavailable and normalizes compute mode", () => {
    const properties = buildTranscriptionAnalyticsProperties({
      outputAction: "paste",
      text: "hej",
      durationSeconds: 12,
      computeMode: "unexpected-engine",
    });

    expect(properties.compute_mode).toBe("unknown");
    expect(properties).not.toHaveProperty("realtime_factor_x100");
  });

  it("reports the configured language rather than anything derived from speech", () => {
    // This is the language setting, not a detection result. Reporting what
    // whisper decided a recording sounded like would be a fact about the
    // contents of someone's audio.
    expect(
      buildTranscriptionAnalyticsProperties({
        outputAction: "paste",
        text: "hej",
        preferredLanguage: "  DA  ",
      }).language
    ).toBe("da");
  });

  it("categorizes arbitrary source and language strings before analytics IPC", () => {
    const properties = buildTranscriptionAnalyticsProperties({
      source: "confidential-client-42",
      outputAction: "paste",
      text: "hello",
      preferredLanguage: "secret-project-codename",
    });

    expect(properties).toMatchObject({ source: "unknown", language: "unset" });
    expect(
      buildTranscriptionAnalyticsProperties({
        source: "openai-reasoned",
        outputAction: "paste",
        text: "hello",
      }).source
    ).toBe("openai-reasoned");
  });

  it("divides by the audio handed to the model, and buckets what was recorded", () => {
    // A long session hands over chunks that do not add up to the wall clock.
    // Mixing the two would report a speed nobody can reproduce, and moving the
    // bucket off the recording would misreport how long people dictate for.
    const properties = buildTranscriptionAnalyticsProperties({
      source: "long-session",
      outputAction: "paste",
      text: "hello",
      durationSeconds: 140,
      transcriptionAudioDurationSeconds: 90,
      transcriptionProcessingDurationMs: 3000,
    });

    expect(properties).toMatchObject({
      duration_bucket: "61-300s",
      realtime_factor_x100: 3000,
    });
  });

  it("distinguishes auto-detect from an explicit choice", () => {
    // Auto is the answer that matters most: it is the setting that costs
    // accuracy, and there is no other way to see how many people sit on it.
    expect(
      buildTranscriptionAnalyticsProperties({
        outputAction: "paste",
        text: "hej",
        preferredLanguage: "auto",
      }).language
    ).toBe("auto");

    expect(
      buildTranscriptionAnalyticsProperties({ outputAction: "paste", text: "hej" }).language
    ).toBe("unset");
  });

  it("reports the model so language and model can be read together", () => {
    const properties = buildTranscriptionAnalyticsProperties({
      outputAction: "paste",
      text: "hej",
      preferredLanguage: "da",
      model: "base",
    });

    expect(properties).toMatchObject({ language: "da", model: "base" });
  });

  it("does not expose arbitrary custom model identifiers", () => {
    const properties = buildTranscriptionAnalyticsProperties({
      outputAction: "paste",
      text: "hello",
      model: "acme-private-model-v7",
    });

    expect(properties.model).toBe("custom");
  });

  it("falls back to unknown rather than dropping the model field", () => {
    expect(
      buildTranscriptionAnalyticsProperties({ outputAction: "paste", text: "hej" }).model
    ).toBe("unknown");
  });

  it("keeps controlled mixed categories for long-session fallback combinations", () => {
    const properties = buildTranscriptionAnalyticsProperties({
      outputAction: "paste",
      text: "combined long session",
      model: "mixed",
      computeMode: "mixed",
    });

    expect(properties).toMatchObject({ model: "mixed", compute_mode: "mixed" });
  });

  it("handles long and unknown-duration dictations", () => {
    const properties = buildTranscriptionAnalyticsProperties({
      source: undefined,
      outputAction: "copy",
      text: "word ".repeat(1200),
      durationSeconds: undefined,
    });

    expect(properties).toMatchObject({
      source: "unknown",
      output_action: "copy",
      word_count_bucket: "1001+",
      duration_bucket: "unknown",
    });
  });
});
