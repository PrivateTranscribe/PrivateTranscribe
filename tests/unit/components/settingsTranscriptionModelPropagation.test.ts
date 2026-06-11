import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("Settings transcription model propagation", () => {
  const readSettingsPage = () =>
    fs.readFileSync(path.join(process.cwd(), "src", "components", "SettingsPage.tsx"), "utf8");

  it("broadcasts local Whisper model changes instead of only updating Settings state", () => {
    const contents = readSettingsPage();
    const pickerBlock =
      contents.split("<TranscriptionModelPicker")[1]?.split('variant="settings"')[0] ?? "";

    expect(pickerBlock).toContain("updateTranscriptionSettings({ whisperModel: modelId })");
    expect(pickerBlock).not.toContain("setWhisperModel(modelId)");
  });

  it("broadcasts related transcription picker changes so AudioManager snapshots do not go stale", () => {
    const contents = readSettingsPage();
    const pickerBlock =
      contents.split("<TranscriptionModelPicker")[1]?.split('variant="settings"')[0] ?? "";

    expect(pickerBlock).toContain(
      "updateTranscriptionSettings({ cloudTranscriptionProvider: provider })"
    );
    expect(pickerBlock).toContain(
      "updateTranscriptionSettings({ cloudTranscriptionModel: model })"
    );
    expect(pickerBlock).toContain(
      "updateTranscriptionSettings({ localTranscriptionProvider: providerId })"
    );
    expect(pickerBlock).toContain("updateTranscriptionSettings({ whisperForceCpu: forceCpu })");
    expect(pickerBlock).toContain("updateTranscriptionSettings({ useLocalWhisper: isLocal })");
  });

  it("defers expensive diagnostics until their settings sections are visible", () => {
    const contents = readSettingsPage();

    expect(contents).toContain('if (activeSection !== "transcription") return;');
    expect(contents).toContain('if (activeSection !== "permissions") return;');
    expect(contents).toContain("checkPasteToolsOnMount: false");
    expect(contents).not.toContain("useWhisper()");
  });
});
