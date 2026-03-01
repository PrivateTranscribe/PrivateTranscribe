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

    const idxValuePattern = src.indexOf("ValuePattern");
    const idxNameFallback = src.indexOf("$el.Current.Name");
    const idxTextPattern = src.indexOf("TextPattern");

    // If the snippet changes significantly these indices can move, but the ordering
    // should remain stable: typical text inputs -> control name -> document/text views.
    expect(idxValuePattern).toBeGreaterThan(-1);
    expect(idxNameFallback).toBeGreaterThan(-1);
    expect(idxTextPattern).toBeGreaterThan(-1);

    expect(idxValuePattern).toBeLessThan(idxNameFallback);
    expect(idxNameFallback).toBeLessThan(idxTextPattern);
  });
});
