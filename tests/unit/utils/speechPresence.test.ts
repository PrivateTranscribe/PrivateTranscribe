import { describe, expect, test } from "vitest";
import { summarizeSpeechLevels } from "../../../src/utils/speechPresence";

/** A stationary level, as room tone or a muted microphone reads. */
const flat = (level: number, frames = 60) =>
  Array.from({ length: frames }, (_, i) => level * (1 + ((i % 5) - 2) * 0.05));

describe("summarizeSpeechLevels", () => {
  test("calls digital silence silence", () => {
    expect(summarizeSpeechLevels(flat(0))).toMatchObject({
      measured: true,
      speechDetected: false,
    });
  });

  test("calls quiet room tone silence", () => {
    expect(summarizeSpeechLevels(flat(0.004))).toMatchObject({
      measured: true,
      speechDetected: false,
    });
  });

  test("keeps ordinary dictation", () => {
    const levels = [...flat(0.003, 20), 0.12, 0.24, 0.31, 0.18, 0.09, ...flat(0.003, 20)];
    expect(summarizeSpeechLevels(levels)).toMatchObject({ speechDetected: true });
  });

  test("keeps speech from a quiet microphone that never reaches the absolute floor", () => {
    const levels = [...flat(0.0008, 20), 0.009, 0.012, 0.011, 0.007, ...flat(0.0008, 20)];
    expect(summarizeSpeechLevels(levels)).toMatchObject({ speechDetected: true });
  });

  test("keeps continuous speech with no pauses to set a low median", () => {
    expect(summarizeSpeechLevels(flat(0.09))).toMatchObject({ speechDetected: true });
  });

  test("calls a lone keyboard click silence", () => {
    expect(summarizeSpeechLevels([...flat(0.002, 30), 0.4, ...flat(0.002, 30)])).toMatchObject({
      speechDetected: false,
    });
  });

  test("reports an unreadable microphone as unmeasured, never as silence", () => {
    expect(summarizeSpeechLevels([])).toMatchObject({ measured: false, speechDetected: true });
    expect(summarizeSpeechLevels([0.001, 0.001])).toMatchObject({
      measured: false,
      speechDetected: true,
    });
  });

  test("ignores unusable readings", () => {
    expect(summarizeSpeechLevels([NaN, -1, ...flat(0.004)])).toMatchObject({
      measured: true,
      readings: 60,
    });
  });
});
