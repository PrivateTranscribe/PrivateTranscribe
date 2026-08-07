import { spawnSync } from "node:child_process";
import { describe, expect, test } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  parseWindowsFastPasteOutput,
  resolveWindowsFastPasteExecutable,
} = require("../../../src/helpers/windowsPasteTarget");

const helperPath = process.platform === "win32" ? resolveWindowsFastPasteExecutable() : null;

// Exercises the compiled helper itself, which unit tests of the JS wrapper
// cannot cover. --detect-only reports the target without sending any keystroke,
// so this is safe to run alongside other tests. Skipped where the binary has not
// been built (non-Windows machines and CI runners that skip compile:native).
describe.runIf(helperPath)("windows-fast-paste.exe", () => {
  test("reports a parseable target without pasting", () => {
    const result = spawnSync(helperPath as string, ["--detect-only"], {
      encoding: "utf8",
      timeout: 5000,
      windowsHide: true,
    });

    expect(result.status).toBe(0);

    const parsed = parseWindowsFastPasteOutput(result.stdout);
    expect(parsed.pasted).toBe(false);
    expect(typeof parsed.isTerminal).toBe("boolean");
    expect(typeof parsed.windowClass).toBe("string");
  });

  test("never reports the window title", () => {
    const result = spawnSync(helperPath as string, ["--detect-only"], {
      encoding: "utf8",
      timeout: 5000,
      windowsHide: true,
    });

    expect(Object.keys(JSON.parse(result.stdout.trim())).sort()).toEqual([
      "chord",
      "isTerminal",
      "pasted",
      "processName",
      "windowClass",
    ]);
  });
});
