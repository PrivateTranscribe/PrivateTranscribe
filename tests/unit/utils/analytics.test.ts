import { describe, expect, it } from "vitest";
import { buildTranscriptionAnalyticsProperties } from "../../../src/utils/analytics";

describe("transcription analytics properties", () => {
  it("returns broad usage buckets without transcript content", () => {
    const privateText = "Discuss the confidential acquisition timeline with the legal team";
    const properties = buildTranscriptionAnalyticsProperties({
      source: "local",
      outputAction: "paste",
      text: privateText,
      durationSeconds: 12,
      preferredLanguage: "da",
      model: "turbo",
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
    });
    expect(JSON.stringify(properties)).not.toContain(privateText);
    expect(properties).not.toHaveProperty("text");
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

  it("falls back to unknown rather than dropping the model field", () => {
    expect(
      buildTranscriptionAnalyticsProperties({ outputAction: "paste", text: "hej" }).model
    ).toBe("unknown");
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
