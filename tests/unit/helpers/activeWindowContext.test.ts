import { describe, expect, test } from "vitest";

// activeWindowContext is a CommonJS helper used by the Electron main process.
// We only unit-test the privacy guardrails here.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  isSensitiveAppContext,
  shouldCaptureContextCapture,
  shouldCaptureWindowsUia,
  shouldCaptureWindowsUiaTextPattern,
  __test,
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

  test("can explicitly disable Windows UIA TextPattern fallback via env var", () => {
    const prev = process.env.PRIVOCA_DISABLE_WINDOWS_UIA_TEXTPATTERN;
    try {
      delete process.env.PRIVOCA_DISABLE_WINDOWS_UIA_TEXTPATTERN;
      expect(shouldCaptureWindowsUiaTextPattern()).toBe(true);

      process.env.PRIVOCA_DISABLE_WINDOWS_UIA_TEXTPATTERN = "1";
      expect(shouldCaptureWindowsUiaTextPattern()).toBe(false);

      process.env.PRIVOCA_DISABLE_WINDOWS_UIA_TEXTPATTERN = "true";
      expect(shouldCaptureWindowsUiaTextPattern()).toBe(false);

      process.env.PRIVOCA_DISABLE_WINDOWS_UIA_TEXTPATTERN = "0";
      expect(shouldCaptureWindowsUiaTextPattern()).toBe(true);
    } finally {
      if (typeof prev === "undefined") delete process.env.PRIVOCA_DISABLE_WINDOWS_UIA_TEXTPATTERN;
      else process.env.PRIVOCA_DISABLE_WINDOWS_UIA_TEXTPATTERN = prev;
    }
  });

  test("can tune captured window-title and UIA text max chars via env vars", () => {
    const prevTitle = process.env.PRIVOCA_CONTEXT_MAX_CHARS_WINDOW_TITLE;
    const prevUia = process.env.PRIVOCA_CONTEXT_MAX_CHARS_UIA_TEXT;

    try {
      delete process.env.PRIVOCA_CONTEXT_MAX_CHARS_WINDOW_TITLE;
      delete process.env.PRIVOCA_CONTEXT_MAX_CHARS_UIA_TEXT;

      expect(__test.getWindowTitleMaxChars()).toBe(512);
      expect(__test.getUiaTextMaxChars()).toBe(512);

      process.env.PRIVOCA_CONTEXT_MAX_CHARS_WINDOW_TITLE = "128";
      expect(__test.getWindowTitleMaxChars()).toBe(128);

      process.env.PRIVOCA_CONTEXT_MAX_CHARS_UIA_TEXT = "256";
      expect(__test.getUiaTextMaxChars()).toBe(256);

      // Invalid values should fall back to defaults.
      process.env.PRIVOCA_CONTEXT_MAX_CHARS_WINDOW_TITLE = "-1";
      expect(__test.getWindowTitleMaxChars()).toBe(512);

      process.env.PRIVOCA_CONTEXT_MAX_CHARS_UIA_TEXT = "not-a-number";
      expect(__test.getUiaTextMaxChars()).toBe(512);

      // Too small: keep a minimum to preserve some usefulness.
      process.env.PRIVOCA_CONTEXT_MAX_CHARS_UIA_TEXT = "8";
      expect(__test.getUiaTextMaxChars()).toBe(512);
    } finally {
      if (typeof prevTitle === "undefined") delete process.env.PRIVOCA_CONTEXT_MAX_CHARS_WINDOW_TITLE;
      else process.env.PRIVOCA_CONTEXT_MAX_CHARS_WINDOW_TITLE = prevTitle;

      if (typeof prevUia === "undefined") delete process.env.PRIVOCA_CONTEXT_MAX_CHARS_UIA_TEXT;
      else process.env.PRIVOCA_CONTEXT_MAX_CHARS_UIA_TEXT = prevUia;
    }
  });

  test("supports env-configured sensitive app patterns (regex + substring)", () => {
    const prev = process.env.PRIVOCA_CONTEXT_SENSITIVE_APP_PATTERNS;

    try {
      process.env.PRIVOCA_CONTEXT_SENSITIVE_APP_PATTERNS = "/okta/i, yubikey, /(unclosed/";

      // Regex literal should match.
      expect(isSensitiveAppContext({ appName: "Okta Verify" })).toBe(true);

      // Substring entries should match (case-insensitive).
      expect(isSensitiveAppContext({ processName: "YubiKey Manager" })).toBe(true);

      // Invalid regex literal should safely degrade to literal substring matching.
      // (We don't want crashes or accidental broad patterns.)
      expect(isSensitiveAppContext({ appName: "My /(unclosed/ app" })).toBe(true);

      // And ensure normal apps stay unblocked.
      expect(isSensitiveAppContext({ appName: "Visual Studio Code", windowTitle: "notes" })).toBe(false);

      // Parsing helper should return RegExp objects and never throw.
      const patterns = __test.parseSensitivePatternsEnv(process.env.PRIVOCA_CONTEXT_SENSITIVE_APP_PATTERNS);
      expect(Array.isArray(patterns)).toBe(true);
      expect(patterns.length).toBeGreaterThan(0);
      for (const p of patterns) expect(p).toBeInstanceOf(RegExp);
    } finally {
      if (typeof prev === "undefined") delete process.env.PRIVOCA_CONTEXT_SENSITIVE_APP_PATTERNS;
      else process.env.PRIVOCA_CONTEXT_SENSITIVE_APP_PATTERNS = prev;
    }
  });
});
