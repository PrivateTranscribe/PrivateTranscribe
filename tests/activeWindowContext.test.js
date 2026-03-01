const { isSensitiveAppContext } = require("../src/helpers/activeWindowContext");

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
