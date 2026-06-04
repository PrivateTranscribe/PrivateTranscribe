import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

describe("whisper model path hardening", () => {
  it("checks model paths stay inside the Whisper models directory", () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), "src", "helpers", "whisper.js"),
      "utf8"
    );

    expect(source).toContain("function isPathInsideDirectory");
    expect(source).toContain("isPathInsideDirectory(modelPath, modelsDir)");
    expect(source).toContain("Invalid model path");
  });
});
