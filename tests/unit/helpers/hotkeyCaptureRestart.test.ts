import { describe, expect, test } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ipcHandlers = fs.readFileSync(
  path.resolve(__dirname, "../../../src/helpers/ipcHandlers.js"),
  "utf8"
);

describe("Windows hotkey capture restart", () => {
  test("restarts native listener after capture for tap and push modes", () => {
    expect(ipcHandlers).toContain("restart the native listener after capture for both tap and");
    expect(ipcHandlers).toContain("this.windowsKeyManager.start(effectiveHotkey)");
    expect(ipcHandlers).not.toContain('activationMode === "push" && effectiveHotkey');
  });
});
