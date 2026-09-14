import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  parseWindowsFastPasteOutput,
  resolveWindowsFastPasteExecutable,
} = require("../../../src/helpers/windowsPasteTarget");

const helperPath = process.platform === "win32" ? resolveWindowsFastPasteExecutable() : null;
const helperSource = readFileSync(
  path.resolve(process.cwd(), "resources", "windows-fast-paste.cs"),
  "utf8"
);

describe("windows-fast-paste source contract", () => {
  test("requires the same focused automation element before confirming insertion", () => {
    expect(helperSource).toContain("focused.GetRuntimeId()");
    expect(helperSource).toContain("SameRuntimeId(textBefore.RuntimeId, textAfter.RuntimeId)");
  });

  // Chromium exposes ValuePattern on a Document element and answers it with the
  // document URL, which never changes when text is pasted. Reading that instead
  // of the text made every paste into a contenteditable composer (Claude
  // Desktop, Slack, Notion) report as unconfirmed.
  // Separating the two lets the app stay quiet about a paste it could not see,
  // instead of telling the user it failed.
  test("separates a field it watched from one it could not read", () => {
    expect(helperSource).toContain('EvidenceAbsent = "absent"');
    expect(helperSource).toContain('EvidenceNone = "none"');
    expect(helperSource).toContain("return watchedTheSameField ? EvidenceAbsent : EvidenceNone;");
  });

  test("reads the focused text through TextPattern before ValuePattern", () => {
    const textPatternAt = helperSource.indexOf("TryGetCurrentPattern(TextPattern.Pattern");
    const valuePatternAt = helperSource.indexOf("TryGetCurrentPattern(ValuePattern.Pattern");

    expect(textPatternAt).toBeGreaterThan(-1);
    expect(valuePatternAt).toBeGreaterThan(-1);
    expect(textPatternAt).toBeLessThan(valuePatternAt);
  });
});

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
    expect(parsed.dispatched).toBe(false);
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
      "dispatched",
      "enterSent",
      "evidence",
      "heldModifierCount",
      "isTerminal",
      "pasted",
      "processName",
      "sendEnter",
      "targetChanged",
      "windowClass",
    ]);
  });
});
