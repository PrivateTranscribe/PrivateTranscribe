import { describe, expect, test } from "vitest";

// activeWindowContext is a CommonJS helper used by the Electron main process.
// We only unit-test the privacy guardrails here.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { isSensitiveAppContext } = require("../../../src/helpers/activeWindowContext");

describe("activeWindowContext privacy guardrails", () => {
  test("blocks known password managers by app/process/class", () => {
    expect(isSensitiveAppContext({ appName: "1Password" })).toBe(true);
    expect(isSensitiveAppContext({ processName: "bitwarden" })).toBe(true);
    expect(isSensitiveAppContext({ appClass: "KeePassXC" })).toBe(true);
  });

  test("blocks OS credential prompts and explicit password prompt wording", () => {
    expect(isSensitiveAppContext({ windowTitle: "Windows Security" })).toBe(true);
    expect(isSensitiveAppContext({ windowTitle: "User Account Control" })).toBe(true);
    expect(isSensitiveAppContext({ windowTitle: "Enter password to unlock" })).toBe(true);
    expect(isSensitiveAppContext({ windowTitle: "Master password required" })).toBe(true);
  });

  test("does not over-block generic document titles containing 'passwords'", () => {
    // Intentionally allowed: a document/article title that includes the word "passwords".
    // Guardrail should only block well-known app names + OS prompts.
    expect(
      isSensitiveAppContext({
        appName: "Google Chrome",
        processName: "chrome",
        windowTitle: "Passwords in CSS: a beginner guide",
      })
    ).toBe(false);
  });
});
