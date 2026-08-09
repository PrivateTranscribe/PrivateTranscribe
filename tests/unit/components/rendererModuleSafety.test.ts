import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";

describe("renderer module safety", () => {
  test("does not use CommonJS require in the transcription model picker", () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), "src", "components", "TranscriptionModelPicker.tsx"),
      "utf8"
    );

    expect(source).not.toMatch(/\brequire\s*\(/);
    expect(source).toContain(
      'import { API_ENDPOINTS, normalizeBaseUrl } from "../config/constants"'
    );
  });
});
