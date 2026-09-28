import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function readSource(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

describe("correction memory write path", () => {
  it("exposes only the explicitly confirmed correction write path", () => {
    const preload = readSource("preload.js");
    const ipcHandlers = readSource("src/helpers/ipcHandlers.js");
    const electronTypes = readSource("src/types/electron.ts");

    expect(preload).toContain("confirmCorrection:");
    expect(ipcHandlers).toContain('ipcMain.handle("db-confirm-correction"');
    expect(preload).not.toContain("upsertCorrection:");
    expect(ipcHandlers).not.toContain('ipcMain.handle("db-upsert-correction"');
    expect(electronTypes).not.toContain("upsertCorrection:");
  });
});
