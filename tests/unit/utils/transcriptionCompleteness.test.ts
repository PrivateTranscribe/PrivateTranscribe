import { describe, expect, test } from "vitest";
import { assessTranscriptionCompleteness } from "../../../src/utils/transcriptionCompleteness";

describe("assessTranscriptionCompleteness", () => {
  test("flags a one-word result from a 30-second recording as suspicious", () => {
    expect(assessTranscriptionCompleteness({ text: "Okay", durationSeconds: 30 })).toMatchObject({
      suspicious: true,
      reason: "very-low-word-count",
    });
  });

  test.each([
    ["Chinese", "今天天气很好我们去公园散步吧然后一起吃午饭"],
    ["Japanese", "今日はいい天気ですね、散歩に行きましょう"],
    ["Thai", "สวัสดีครับวันนี้อากาศดีมากเราไปเดินเล่นกัน"],
  ])("does not flag a full %s sentence, written without spaces", (_language, text) => {
    // Split on whitespace, the whole sentence counted as one word, so every
    // dictation of 20 seconds or more warned that it may be incomplete.
    const result = assessTranscriptionCompleteness({ text, durationSeconds: 25 });

    expect(result.suspicious).toBe(false);
    expect(result.wordCount).toBeGreaterThan(1);
  });

  test("counts words, not punctuation, in spaced text", () => {
    expect(
      assessTranscriptionCompleteness({ text: "Hello there , world !", durationSeconds: 5 })
    ).toMatchObject({ wordCount: 3 });
  });
});
