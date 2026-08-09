import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";

const readSource = (relativePath: string) =>
  fs.readFileSync(path.join(process.cwd(), relativePath), "utf8");

describe("dictation audio privacy", () => {
  test("does not expose or invoke raw-audio recovery persistence", () => {
    const combinedSource = [
      "main.js",
      "preload.js",
      "src/helpers/audioManager.js",
      "src/helpers/ipcHandlers.js",
      "src/components/pages/HistoryPage.tsx",
    ]
      .map(readSource)
      .join("\n");

    for (const retiredIdentifier of [
      "stageDictationRecovery",
      "dictation-recovery-stage",
      "listDictationRecoveries",
      "Recovered audio",
    ]) {
      expect(combinedSource).not.toContain(retiredIdentifier);
    }

    expect(fs.existsSync(path.join(process.cwd(), "src/helpers/dictationRecoveryManager.js"))).toBe(
      false
    );
  });
});
