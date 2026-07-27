import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

// Guards the Windows regression where the app re-registered (and silently re-approved)
// its login item, so a user who disabled startup in Task Manager still got launched.
describe("auto-start respects the Windows Task Manager state", () => {
  const read = (...segments: string[]) =>
    fs.readFileSync(path.join(process.cwd(), ...segments), "utf8").replace(/\r\n/g, "\n");

  it("resolves the in-app toggle from what the OS will actually launch", () => {
    const source = read("src", "helpers", "ipcHandlers.js");

    expect(source).toContain("resolveAutoStartEnabled(loginSettings, process.platform)");
    // openAtLogin alone only reports the Run key, not the StartupApproved flag.
    expect(source).not.toContain("return loginSettings.openAtLogin");
    expect(source).not.toContain("return app.getLoginItemSettings().openAtLogin");
  });

  it("does not rewrite the login item when auto-start is off", () => {
    const source = read("src", "helpers", "ipcHandlers.js");

    expect(source).toMatch(
      /if \(wasEnabled\) \{\s*app\.setLoginItemSettings\(\s*this\._buildAutoStartSetOptions\(true, launchMode, true\)\s*\);/
    );
  });

  it("keeps the first-run default from overruling an existing user decision", () => {
    const source = read("main.js");

    expect(source).toContain("getAutoStartApprovalState");
    expect(source).toContain("if (existingApproval === null) {");
  });
});
