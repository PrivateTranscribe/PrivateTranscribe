import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

const source = () => fs.readFileSync(path.join(process.cwd(), "src", "helpers", "whisper.js"), "utf8");

describe("whisper model file validation", () => {
  it("does not treat any existing ggml file as downloaded", () => {
    const contents = source();

    expect(contents).toContain("function getMinimumValidModelBytes");
    expect(contents).toContain("getModelFileStatus(modelName)");
    expect(contents).toContain("stats.size >= minSize");
    expect(contents).toContain("return this.getModelFileStatus(modelName).valid");
  });

  it("reports incomplete models as invalid and re-downloads them", () => {
    const contents = source();

    expect(contents).toContain("Removing incomplete Whisper model before re-download");
    expect(contents).toContain("downloaded,");
    expect(contents).toContain("valid: downloaded");
    expect(contents).toContain("getInvalidModelMessage(modelName, stats.size)");
  });

  it("blocks transcription before starting whisper-server with an incomplete model", () => {
    const contents = source();

    expect(contents).toContain("const modelStatus = this.getModelFileStatus(model)");
    expect(contents).toContain("if (!modelStatus.valid)");
    expect(contents).toContain("getInvalidModelMessage(model, modelStatus.size)");
  });
});
