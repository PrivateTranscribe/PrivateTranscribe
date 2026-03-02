import { describe, expect, test } from "vitest";

// activeWindowContext is a CommonJS helper used by the Electron main process.
// We only unit-test the privacy guardrails here.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  isSensitiveAppContext,
  shouldCaptureContextCapture,
  shouldCaptureWindowsUia,
} = require("../../../src/helpers/activeWindowContext");

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

  test("can explicitly disable all context capture via env var", () => {
    const prev = process.env.PRIVOCA_DISABLE_CONTEXT_CAPTURE;
    try {
      delete process.env.PRIVOCA_DISABLE_CONTEXT_CAPTURE;
      expect(shouldCaptureContextCapture()).toBe(true);

      process.env.PRIVOCA_DISABLE_CONTEXT_CAPTURE = "1";
      expect(shouldCaptureContextCapture()).toBe(false);

      process.env.PRIVOCA_DISABLE_CONTEXT_CAPTURE = "true";
      expect(shouldCaptureContextCapture()).toBe(false);

      process.env.PRIVOCA_DISABLE_CONTEXT_CAPTURE = "0";
      expect(shouldCaptureContextCapture()).toBe(true);
    } finally {
      if (typeof prev === "undefined") delete process.env.PRIVOCA_DISABLE_CONTEXT_CAPTURE;
      else process.env.PRIVOCA_DISABLE_CONTEXT_CAPTURE = prev;
    }
  });

  test("can explicitly disable Windows UIA capture via env var", () => {
    const prev = process.env.PRIVOCA_DISABLE_WINDOWS_UIA;
    try {
      delete process.env.PRIVOCA_DISABLE_WINDOWS_UIA;
      expect(shouldCaptureWindowsUia()).toBe(true);

      process.env.PRIVOCA_DISABLE_WINDOWS_UIA = "1";
      expect(shouldCaptureWindowsUia()).toBe(false);

      process.env.PRIVOCA_DISABLE_WINDOWS_UIA = "true";
      expect(shouldCaptureWindowsUia()).toBe(false);

      process.env.PRIVOCA_DISABLE_WINDOWS_UIA = "0";
      expect(shouldCaptureWindowsUia()).toBe(true);
    } finally {
      if (typeof prev === "undefined") delete process.env.PRIVOCA_DISABLE_WINDOWS_UIA;
      else process.env.PRIVOCA_DISABLE_WINDOWS_UIA = prev;
    }
  });
});
