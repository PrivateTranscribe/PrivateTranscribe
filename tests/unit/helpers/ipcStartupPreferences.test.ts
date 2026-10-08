import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

describe("ipcHandlers sync-startup-preferences", () => {
  it("clears stale local transcription pre-warm env vars instead of persisting them", () => {
    const filePath = path.join(process.cwd(), "src", "helpers", "ipcHandlers.js");
    const source = fs.readFileSync(filePath, "utf8");

    expect(source).toContain('clearVars.push("LOCAL_TRANSCRIPTION_PROVIDER", "PARAKEET_MODEL", "LOCAL_WHISPER_MODEL")');
    expect(source).not.toContain("setVars.LOCAL_TRANSCRIPTION_PROVIDER");
    expect(source).not.toContain("setVars.PARAKEET_MODEL");
    // Loading Parakeet on record start must not rewrite the saved keys file each time.
    expect(source).not.toContain("process.env.PARAKEET_MODEL =");
    expect(source).not.toContain("setVars.LOCAL_WHISPER_MODEL");
  });
});
