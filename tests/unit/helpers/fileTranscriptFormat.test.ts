import { describe, expect, it } from "vitest";

const { formatFileTranscript } = require("../../../src/helpers/ipcHandlers");

const unlabelled = {
  segments: [
    { start: 0, end: 2, text: " Kan vi starte?" },
    { start: 2, end: 3, text: " Ja." },
  ],
};

describe("formatFileTranscript", () => {
  it("formats a run whose speaker labels failed like a run with labels off", () => {
    const failed = formatFileTranscript(
      { success: true, raw: unlabelled, speakerLabelsError: "The speaker engine crashed." },
      { outputFormat: "speakers", speakerDetection: true },
      "off"
    );
    const labelsOff = formatFileTranscript(
      { success: true, raw: unlabelled },
      { outputFormat: "timestamped", speakerDetection: false },
      "off"
    );

    expect(failed.text).toBe("[00:00:00] Kan vi starte?\n[00:00:02] Ja.");
    expect(failed.text).toBe(labelsOff.text);
    expect(failed.srt).toBe(labelsOff.srt);
    expect(failed.format).toBe("timestamped");
  });

  it("keeps speaker names when the labels arrived", () => {
    const labelled = {
      segments: [
        { start: 0, end: 2, text: " Kan vi starte?", speaker: "Speaker 1" },
        { start: 2, end: 3, text: " Ja.", speaker: "Speaker 2" },
      ],
    };

    const result = formatFileTranscript(
      { success: true, raw: labelled },
      { outputFormat: "speakers", speakerDetection: true },
      "local-diarization"
    );

    expect(result.text).toBe("Speaker 1: Kan vi starte?\nSpeaker 2: Ja.");
    expect(result.format).toBe("speakers");
  });
});
