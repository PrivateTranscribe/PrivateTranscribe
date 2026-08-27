/**
 * The renderer's copy of whisper's language set has to stay equal to the main
 * process's table, or the two halves of the F3 guard disagree: the renderer
 * would fall back to auto-detect for a code the engine accepts, or forward one
 * it does not.
 *
 * They are separate files because the main-process table is CommonJS and keyed
 * by whisper's full language names, which the renderer bundle cannot import.
 * This test is the join.
 */
import { describe, expect, it } from "vitest";
import {
  WHISPER_LANGUAGE_CODES,
  isWhisperLanguageCode,
} from "../../../src/utils/whisperLanguageCodes";

const { WHISPER_NAME_TO_CODE, isKnownWhisperLanguage } = require("../../../src/helpers/whisperLanguage");

describe("whisper language codes", () => {
  it("matches the main process's table exactly", () => {
    const fromMainProcess = [...new Set<string>(Object.values(WHISPER_NAME_TO_CODE))].sort();
    expect([...WHISPER_LANGUAGE_CODES].sort()).toEqual(fromMainProcess);
  });

  it("agrees with the main process on individual codes", () => {
    for (const code of ["en", "da", "yue", "haw", "zz", ""]) {
      expect(isWhisperLanguageCode(code)).toBe(code !== "zz" && code !== "");
      expect(isKnownWhisperLanguage(code)).toBe(isWhisperLanguageCode(code));
    }
  });

  it("does not treat 'auto' as a code, but the main process still accepts it", () => {
    // "auto" is how a caller spells "do not pin a language"; it is never sent.
    expect(isWhisperLanguageCode("auto")).toBe(false);
    expect(isKnownWhisperLanguage("auto")).toBe(true);
  });

  it("covers whisper's full set, not the UI picker's subset", () => {
    expect(WHISPER_LANGUAGE_CODES.length).toBeGreaterThan(90);
  });
});
