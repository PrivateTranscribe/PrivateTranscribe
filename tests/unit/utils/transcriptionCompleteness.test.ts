import { describe, expect, test } from "vitest";
import { assessTranscriptionCompleteness } from "../../../src/utils/transcriptionCompleteness";

describe("assessTranscriptionCompleteness", () => {
  test("flags a one-word result from a 30-second recording as suspicious", () => {
    expect(assessTranscriptionCompleteness({ text: "Okay", durationSeconds: 30 })).toMatchObject({
      suspicious: true,
      reason: "very-low-word-count",
    });
  });
});
