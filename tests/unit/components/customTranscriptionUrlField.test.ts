import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Saving a custom transcription address refuses one the app can't reach, and a
 * half-typed address is never reachable. The field saved on every keystroke, so
 * each character was refused and only a pasted address got in. It now edits a
 * draft and saves on blur.
 */
const source = () =>
  fs.readFileSync(
    path.join(process.cwd(), "src", "components", "TranscriptionModelPicker.tsx"),
    "utf8"
  );

const endpointInput = () => {
  const afterLabel = source().split(">Endpoint URL</label>")[1] ?? "";
  return afterLabel.split("/>")[0];
};

describe("custom transcription address field", () => {
  it("types into a draft instead of saving each keystroke", () => {
    const input = endpointInput();
    expect(input).toContain("value={customBaseDraft}");
    expect(input).toContain("setCustomBaseDraft(e.target.value)");
    expect(input).not.toContain("setCloudTranscriptionBaseUrl");
    expect(input).toContain("onBlur={handleBaseUrlBlur}");
  });

  it("saves the draft on blur only after the address check passes", () => {
    const blur =
      source().split("const handleBaseUrlBlur = useCallback(")[1]?.split("}, [")[0] ?? "";
    const check = blur.indexOf("isValidApiUrl(normalized)");
    const save = blur.indexOf("setCloudTranscriptionBaseUrl(normalized)");
    expect(check).toBeGreaterThan(-1);
    expect(save).toBeGreaterThan(check);
    expect(blur).toContain("setCustomBaseError(");
  });

  it("drops an old refusal when the saved address changes elsewhere", () => {
    const sync =
      source().split("if (savedBase !== cloudTranscriptionBaseUrl) {")[1]?.split("}")[0] ?? "";
    expect(sync).toContain("setCustomBaseDraft(cloudTranscriptionBaseUrl)");
    expect(sync).toContain("setCustomBaseError(null)");
  });
});
