import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("Overlay long-recording status", () => {
  it("keeps background chunking details out of the recording overlay", () => {
    const appSource = fs.readFileSync(path.join(process.cwd(), "src", "App.jsx"), "utf8");

    expect(appSource).not.toContain("Long recording");
    expect(appSource).not.toContain("longSessionStatus");
    expect(appSource).not.toContain("transcribing long-recording chunks");
  });
});
