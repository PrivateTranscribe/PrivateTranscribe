import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

describe("reasoning log redaction", () => {
  it("does not log raw request or response bodies", () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), "src", "services", "ReasoningService.ts"),
      "utf8"
    );

    expect(source).not.toMatch(/requestBody:\s*JSON\.stringify/);
    expect(source).not.toMatch(/fullResponse:\s*/);
    expect(source).not.toMatch(
      /JSON\.stringify\((response|jsonResponse|candidate|choice)\)\.substring/
    );
    expect(source).toContain("summarizeRequestBodyForLog");
    expect(source).toContain("summarizeResponseForLog");
  });
});
