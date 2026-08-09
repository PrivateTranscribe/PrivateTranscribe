import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";

describe("History failed-dictation recovery", () => {
  test("exposes local recovered audio with reveal and delete actions", () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), "src", "components", "pages", "HistoryPage.tsx"),
      "utf8"
    );

    expect(source).toContain("listDictationRecoveries");
    expect(source).toContain("revealDictationRecovery");
    expect(source).toContain("deleteDictationRecovery");
    expect(source).toContain("Recovered audio");
    expect(source).toContain("Stored only on this PC");
  });

  test("wires recovery into IPC without changing benchmark constructor arguments", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "main.js"), "utf8");
    const normalized = source.replace(/\s+/g, " ");

    expect(normalized).toContain(
      "new BenchmarkManager( databaseManager, whisperManager, parakeetManager, hardwareDetector )"
    );
    expect(normalized).toContain("new IPCHandlers({ environmentManager, databaseManager,");
    expect(normalized).toContain("databaseManager, dictationRecoveryManager, clipboardManager");
  });
});
