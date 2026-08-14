/**
 * Tests for whisper model display ordering in the transcription pickers.
 * @module tests/unit/models/whisperModelOrder
 */

import { describe, it, expect } from "vitest";
import {
  compareWhisperModelsForDisplay,
  WHISPER_MODEL_INFO,
} from "../../../src/models/ModelRegistry";

const DICTATION_MODELS = Object.keys(WHISPER_MODEL_INFO).filter((id) => id !== "small-en-tdrz");

const sortIds = (ids: string[], recommendedId?: string | null) =>
  [...ids].sort((a, b) => compareWhisperModelsForDisplay(a, b, recommendedId));

describe("compareWhisperModelsForDisplay", () => {
  it("puts the registry-recommended model first, then orders by download size", () => {
    expect(sortIds(DICTATION_MODELS)).toEqual([
      "turbo",
      "tiny",
      "base",
      "small",
      "medium",
      "large",
    ]);
  });

  it("honours a hardware-recommended override", () => {
    expect(sortIds(DICTATION_MODELS, "base")).toEqual([
      "base",
      "tiny",
      "small",
      "medium",
      "turbo",
      "large",
    ]);
  });

  it("is independent of the input order", () => {
    const reversed = sortIds([...DICTATION_MODELS].reverse());
    expect(reversed).toEqual(sortIds(DICTATION_MODELS));
  });

  it("sorts unknown model ids last but keeps them stable by name", () => {
    const sorted = sortIds([...DICTATION_MODELS, "zeta-unknown", "alpha-unknown"]);
    expect(sorted.slice(-2)).toEqual(["alpha-unknown", "zeta-unknown"]);
  });

  it("breaks size ties by display name", () => {
    // small and small-en-tdrz are both 466MB.
    expect(sortIds(["small-en-tdrz", "small"])).toEqual(["small", "small-en-tdrz"]);
  });
});
