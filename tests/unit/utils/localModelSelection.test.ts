import { describe, expect, it } from "vitest";
import { shouldSelectDownloadedLocalModel } from "../../../src/utils/localModelSelection";

describe("a local AI model that finished downloading after its picker left the screen", () => {
  const atDownloadStart = { provider: "qwen", model: "" };

  it("is switched on when nothing was changed meanwhile", () => {
    expect(
      shouldSelectDownloadedLocalModel(
        { reasoningProvider: "qwen", reasoningModel: "" },
        atDownloadStart
      )
    ).toBe(true);
  });

  it("is switched on under the older saved value for local mode", () => {
    expect(
      shouldSelectDownloadedLocalModel(
        { reasoningProvider: "local", reasoningModel: null },
        atDownloadStart
      )
    ).toBe(true);
  });

  it("replaces the model that was active when the download started", () => {
    expect(
      shouldSelectDownloadedLocalModel(
        { reasoningProvider: "qwen", reasoningModel: "qwen3-0.6b-q8_0" },
        { provider: "qwen", model: "qwen3-0.6b-q8_0" }
      )
    ).toBe(true);
  });

  it("is left alone when the user moved to a cloud provider", () => {
    expect(
      shouldSelectDownloadedLocalModel(
        { reasoningProvider: "openai", reasoningModel: "" },
        atDownloadStart
      )
    ).toBe(false);
  });

  it("is left alone when the user moved to another local provider", () => {
    expect(
      shouldSelectDownloadedLocalModel(
        { reasoningProvider: "gemma", reasoningModel: "" },
        atDownloadStart
      )
    ).toBe(false);
  });

  it("is left alone when the user picked another model meanwhile", () => {
    expect(
      shouldSelectDownloadedLocalModel(
        { reasoningProvider: "qwen", reasoningModel: "qwen3-0.6b-q8_0" },
        atDownloadStart
      )
    ).toBe(false);
  });
});
