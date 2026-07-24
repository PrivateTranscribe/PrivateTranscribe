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
    });

    expect(properties).toEqual({
      source: "local",
      output_action: "paste",
      word_count_bucket: "1-10",
      duration_bucket: "6-15s",
    });
    expect(JSON.stringify(properties)).not.toContain(privateText);
    expect(properties).not.toHaveProperty("text");
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
