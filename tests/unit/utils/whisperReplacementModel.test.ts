import { describe, expect, it } from "vitest";
import { pickReplacementWhisperModel } from "../../../src/utils/whisperReplacementModel";

// Registry order, as listWhisperModels returns it: the speaker-turn model sits
// before every dictation model except turbo and base.
const list = (downloaded: string[]) =>
  ["turbo", "base", "small-en-tdrz", "tiny", "small", "medium", "large"].map((model) => ({
    model,
    downloaded: downloaded.includes(model),
  }));

describe("pickReplacementWhisperModel", () => {
  it("skips the English-only speaker model after the selected model is deleted", () => {
    expect(pickReplacementWhisperModel(list(["small-en-tdrz", "small"]), "turbo")).toBe("small");
  });

  it("leaves no model selected when only the speaker model is left", () => {
    expect(pickReplacementWhisperModel(list(["small-en-tdrz"]), "turbo")).toBe("");
  });

  it("keeps a selected model that is still downloaded", () => {
    expect(pickReplacementWhisperModel(list(["turbo", "base"]), "base")).toBeUndefined();
  });

  it("takes the first downloaded dictation model in list order", () => {
    expect(pickReplacementWhisperModel(list(["base", "tiny"]), "turbo")).toBe("base");
  });
});
