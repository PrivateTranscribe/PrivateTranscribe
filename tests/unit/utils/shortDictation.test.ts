import { describe, expect, it } from "vitest";
import { isShortDictation } from "../../../src/utils/shortDictation";

describe("short dictation detection", () => {
  it.each(["Maren", "Thank you", "Not yet", "mange tak", "東京", "42", "  Okay  ", "don't"])(
    "recognizes %s as a short insertion",
    (text) => {
      expect(isShortDictation(text)).toBe(true);
    }
  );
  it.each(["", "...", "Please send the notes", "明日の会議に参加できません。", "请把文件发送给我"])(
    "does not bypass longer or nonverbal input: %s",
    (text) => {
      expect(isShortDictation(text)).toBe(false);
    }
  );
});
