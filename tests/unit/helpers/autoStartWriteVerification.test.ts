import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

// Guards the Windows regression where `setLoginItemSettings` silently did nothing —
// antivirus blocking the HKCU Run key — while the toggle stayed on and the app never
// launched at login. Every layer must report the state that was read back, not the
// state that was requested.
describe("auto-start reports the state the OS actually stored", () => {
  const read = (...segments: string[]) =>
    fs.readFileSync(path.join(process.cwd(), ...segments), "utf8").replace(/\r\n/g, "\n");

  it("re-reads the login item after writing it", () => {
    const source = read("src", "helpers", "ipcHandlers.js");
    const handler = source.slice(source.indexOf('ipcMain.handle("set-auto-start-enabled"'));

    expect(handler).toContain("const actual = this._getAutoStartEnabled(launchMode);");
    expect(handler).toContain("if (actual !== Boolean(enabled)) {");
    // The old handler returned an unconditional success right after the write.
    expect(handler.slice(0, handler.indexOf("const actual"))).not.toContain(
      "return { success: true }"
    );
  });

  it("returns the verified value so the renderer can correct itself", () => {
    const source = read("src", "helpers", "ipcHandlers.js");
    const handler = source.slice(source.indexOf('ipcMain.handle("set-auto-start-enabled"'));

    expect(handler).toContain("enabled: actual");
    expect(handler).toContain("return { success: true, enabled: actual };");
  });

  it("does not let the settings toggle trust the requested value", () => {
    const source = read("src", "components", "SettingsPage.tsx");

    expect(source).toContain("setAutoStartEnabled(result.enabled ??");
    expect(source).not.toMatch(/if \(result\.success\) \{\s*setAutoStartEnabled\(enabled\);/);
  });

  it("does not let onboarding trust the requested value", () => {
    const source = read("src", "components", "OnboardingFlow.tsx");

    expect(source).toContain("setAutoStartEnabled(result?.enabled ??");
    expect(source).not.toMatch(/if \(result\?\.success\) \{\s*setAutoStartEnabled\(enabled\);/);
  });
});

// The first-run default is a one-shot guarded by a marker file. Writing the marker after
// a rejected registry write left the app with no Run entry and no way back: the default
// never fires again, so the user has to find the toggle themselves.
describe("the first-run auto-start default only burns its one-shot once it sticks", () => {
  const read = (...segments: string[]) =>
    fs.readFileSync(path.join(process.cwd(), ...segments), "utf8").replace(/\r\n/g, "\n");

  const firstRunBlock = () => {
    const source = read("main.js");
    const start = source.indexOf('".autostart-initialized"');
    return source.slice(start, source.indexOf("Start Menu shortcut", start));
  };

  it("re-reads the login item after registering the default", () => {
    expect(firstRunBlock()).toContain("defaultApplied = resolveAutoStartEnabled(");
  });

  it("leaves the marker unwritten when the write did not stick", () => {
    const block = firstRunBlock();

    expect(block).toContain("if (defaultApplied) {");
    expect(block).toMatch(/if \(defaultApplied\) \{\s*fs\.writeFileSync\(flagPath, "1"\);/);
    // The old block wrote the marker unconditionally, right after the if/else.
    expect(block).not.toMatch(/\}\s*fs\.writeFileSync\(flagPath, "1"\);\s*\}/);
  });

  it("still writes the marker when an existing user decision is respected", () => {
    const block = firstRunBlock();

    expect(block).toContain("let defaultApplied = true;");
    expect(block).toContain("Skipping first-run auto-start default");
  });
});
