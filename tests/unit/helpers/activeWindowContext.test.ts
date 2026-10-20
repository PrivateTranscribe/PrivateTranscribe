import { spawnSync } from "child_process";
import { describe, expect, test, vi } from "vitest";

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
      if (typeof prevTitle === "undefined")
        delete process.env.PRIVOCA_CONTEXT_MAX_CHARS_WINDOW_TITLE;
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
      expect(isSensitiveAppContext({ appName: "Visual Studio Code", windowTitle: "notes" })).toBe(
        false
      );

      // Parsing helper should return RegExp objects and never throw.
      const patterns = __test.parseSensitivePatternsEnv(
        process.env.PRIVOCA_CONTEXT_SENSITIVE_APP_PATTERNS
      );
      expect(Array.isArray(patterns)).toBe(true);
      expect(patterns.length).toBeGreaterThan(0);
      for (const p of patterns) expect(p).toBeInstanceOf(RegExp);
    } finally {
      if (typeof prev === "undefined") delete process.env.PRIVOCA_CONTEXT_SENSITIVE_APP_PATTERNS;
      else process.env.PRIVOCA_CONTEXT_SENSITIVE_APP_PATTERNS = prev;
    }
  });
});

describe("Windows foreground window capture", () => {
  // Variables PowerShell keeps read-only or constant. Assigning one fails, and
  // the script then carries on with PowerShell's own value.
  const READ_ONLY_VARIABLES = [
    "pid",
    "host",
    "home",
    "pshome",
    "shellid",
    "psversiontable",
    "psculture",
    "psuiculture",
    "executioncontext",
    "true",
    "false",
    "null",
  ];

  /** A fake runner whose foreground query prints `stdout` and finds no focused text. */
  function foregroundRunner(stdout: string) {
    return vi
      .fn()
      .mockReturnValueOnce({ ok: true, status: 0, stdout, stderr: "" })
      .mockReturnValue({ ok: true, status: 0, stdout: "", stderr: "" });
  }

  test("never assigns one of PowerShell's read-only variables", () => {
    const script: string = __test.buildWindowsForegroundScript();
    const assigned = [
      ...script.matchAll(/\$(\w+)\s*=/g),
      ...script.matchAll(/\[ref\]\$(\w+)/g),
    ].map((match) => match[1].toLowerCase());

    expect(assigned.filter((name) => READ_ONLY_VARIABLES.includes(name))).toEqual([]);
    expect(assigned).toContain("ownerid");
  });

  test.runIf(process.platform === "win32")(
    "keeps ø, æ and å in a window title",
    () => {
      // A window that is created but never shown, so nothing on screen changes.
      const testWindow = [
        "Add-Type -AssemblyName System.Windows.Forms",
        "$testForm = New-Object System.Windows.Forms.Form",
        '$testForm.Text = "Søren\'s notes æ å - Notepad"',
      ].join("\n");
      const script = `${testWindow}\n${__test.buildWindowsForegroundScript({
        windowHandle: "$testForm.Handle",
      })}`;
      const res = spawnSync(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
        { encoding: "utf8", timeout: 15000 }
      );

      expect(res.status).toBe(0);
      expect(__test.parseWindowsForegroundOutput(res.stdout).windowTitle).toBe(
        "Søren's notes æ å - Notepad"
      );
    },
    20000
  );

  test("switches both Windows queries to UTF-8 output before they print", () => {
    const runCommand = foregroundRunner("Søren's notes - Notepad\r\nnotepad\r\n");

    expect(__test.getWindowsContext(runCommand)).toMatchObject({
      windowTitle: "Søren's notes - Notepad",
    });
    // The foreground query, then the focused element's text.
    expect(runCommand).toHaveBeenCalledTimes(2);
    for (const [, args] of runCommand.mock.calls) {
      const script: string = args[args.length - 1];
      expect(script.split("\n")[0]).toContain(
        "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false"
      );
    }
  });

  test.runIf(process.platform === "win32")(
    "names the process that owns the window, not PowerShell itself",
    () => {
      // Handle 0 belongs to no window, so the owner id stays 0: the System Idle Process.
      const script = __test.buildWindowsForegroundScript({ windowHandle: "[IntPtr]::Zero" });
      const res = spawnSync(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
        { encoding: "utf8", timeout: 15000 }
      );

      expect(res.status).toBe(0);
      expect(__test.parseWindowsForegroundOutput(res.stdout)).toEqual({
        windowTitle: "",
        processName: "Idle",
      });
    },
    20000
  );

  test.each([
    ["KeePassXC", "Passwords.kdbx [Locked]"],
    ["1Password", "Vault - Personal"],
    ["Bitwarden", "My vault"],
  ])("blocks %s by its process name alone", (processName, windowTitle) => {
    const runCommand = foregroundRunner(`${windowTitle}\r\n${processName}\r\n`);

    expect(__test.getWindowsContext(runCommand)).toEqual({
      available: false,
      reason: "sensitive app/window",
      blocked: true,
    });
    // Blocked before the focused element's text is read.
    expect(runCommand).toHaveBeenCalledTimes(1);
  });

  test("passes an ordinary app's process name and title through", () => {
    const runCommand = foregroundRunner("App.jsx - privoca - Visual Studio Code\r\nCode\r\n");

    expect(__test.getWindowsContext(runCommand)).toEqual({
      available: true,
      platform: "win32",
      method: "powershell",
      processName: "Code",
      windowTitle: "App.jsx - privoca - Visual Studio Code",
    });
  });

  test("keeps the process name in its place when the window has no title", () => {
    const runCommand = foregroundRunner("\r\nexplorer\r\n");

    expect(__test.getWindowsContext(runCommand)).toMatchObject({
      available: true,
      processName: "explorer",
      windowTitle: "",
    });
  });
});
