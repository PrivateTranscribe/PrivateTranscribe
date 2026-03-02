import { describe, expect, test } from "vitest";
import fs from "node:fs";
import path from "node:path";

function readActiveWindowContextSource() {
  const p = path.resolve(
    __dirname,
    "../../../src/helpers/activeWindowContext.js"
  );
  return fs.readFileSync(p, "utf8");
}

describe("Windows UIA context capture script invariants", () => {
  test("PowerShell UIA snippet stays privacy-first", () => {
    const src = readActiveWindowContextSource();

    // Regression guardrails:
    // - Never capture password-field text.
    // - Include TextPattern fallback for richer controls.
    // - Hard-limit any captured text.
    expect(src).toContain("IsPasswordProperty");
    expect(src).toContain("[System.Windows.Automation.TextPattern]::Pattern");
    expect(src).toContain("GetText(512)");

    // Ensure process-local policy override stays in place (common locked-down envs).
    expect(src).toContain("-ExecutionPolicy");
    expect(src).toContain("Bypass");
  });

  test("UIA snippet prefers ValuePattern then Name, before TextPattern", () => {
    const src = readActiveWindowContextSource();

    const textPatternBlockStart = src.indexOf("const textPatternBlock");
    const psStart = src.indexOf("const ps = `");
    expect(textPatternBlockStart).toBeGreaterThan(-1);
    expect(psStart).toBeGreaterThan(textPatternBlockStart);

    const psEnd = src.indexOf("$txt;`", psStart);
    expect(psEnd).toBeGreaterThan(psStart);

    const ps = src.slice(psStart, psEnd);

    // In the executed snippet, TextPattern is injected via ${textPatternBlock}.
    // Enforce ordering as: ValuePattern -> Name fallback -> injection point.
    const idxValuePattern = ps.indexOf("ValuePattern");
    const idxNameFallback = ps.indexOf("$el.Current.Name");
    const idxTextPatternInjection = ps.indexOf("${textPatternBlock}");

    expect(idxValuePattern).toBeGreaterThan(-1);
    expect(idxNameFallback).toBeGreaterThan(-1);
    expect(idxTextPatternInjection).toBeGreaterThan(-1);

    expect(idxValuePattern).toBeLessThan(idxNameFallback);
    expect(idxNameFallback).toBeLessThan(idxTextPatternInjection);

    // And ensure the TextPattern block still contains the actual UIA TextPattern code.
    const between = src.slice(textPatternBlockStart, psStart);
    expect(between).toContain("[System.Windows.Automation.TextPattern]::Pattern");
  });
});
