import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

describe("machine id privacy", () => {
  it("uses hashed machine identifiers for renderer IPC", () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), "src", "helpers", "ipcHandlers.js"),
      "utf8"
    );

    expect(source).toContain("machineIdSync(false)");
    expect(source).not.toContain("machineIdSync(true)");
  });
});
