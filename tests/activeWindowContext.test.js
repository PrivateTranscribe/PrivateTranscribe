const { isSensitiveAppContext, shouldCaptureWindowsUia } = require("../src/helpers/activeWindowContext");

describe("isSensitiveAppContext", () => {
  it("blocks well-known password managers by app/process", () => {
    expect(isSensitiveAppContext({ appName: "1Password" })).toBe(true);
    expect(isSensitiveAppContext({ processName: "bitwarden" })).toBe(true);
    expect(isSensitiveAppContext({ appClass: "KeePassXC" })).toBe(true);
  });

  it("blocks OS credential prompts by process name", () => {
    expect(isSensitiveAppContext({ processName: "LogonUI" })).toBe(true);
    expect(isSensitiveAppContext({ processName: "CredentialUIBroker" })).toBe(true);
  });

  it("does not block generic window titles that merely mention passwords", () => {
    // We explicitly avoid matching the generic word "passwords" in window titles
    // to reduce false positives.
    expect(isSensitiveAppContext({ windowTitle: "Chrome — Passwords are fun" })).toBe(false);
  });

  it("does block explicit credential prompt phrasing", () => {
    expect(isSensitiveAppContext({ windowTitle: "Enter password to unlock" })).toBe(true);
    expect(isSensitiveAppContext({ windowTitle: "Windows Security" })).toBe(true);
  });
});

describe("shouldCaptureWindowsUia", () => {
  const key = "PRIVOCA_DISABLE_WINDOWS_UIA";
  const original = process.env[key];

  afterEach(() => {
    if (typeof original === "undefined") delete process.env[key];
    else process.env[key] = original;
  });

  it("defaults to enabled when env var is unset", () => {
    delete process.env[key];
    expect(shouldCaptureWindowsUia()).toBe(true);
  });

  it("disables UIA capture when env var is set to true-ish values", () => {
    for (const v of ["1", "true", "yes", " TRUE ", "Yes"]) {
      process.env[key] = v;
      expect(shouldCaptureWindowsUia()).toBe(false);
    }
  });

  it("keeps UIA capture enabled for other values", () => {
    for (const v of ["0", "false", "no", "", "random"]) {
      process.env[key] = v;
      expect(shouldCaptureWindowsUia()).toBe(true);
    }
  });
});
