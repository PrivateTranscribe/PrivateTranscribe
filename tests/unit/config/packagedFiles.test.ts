import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(__dirname, "../../..");
const config = JSON.parse(readFileSync(resolve(repoRoot, "electron-builder.json"), "utf8"));

const PLATFORM_SECTIONS = ["win", "nsis", "appx", "portable", "mac", "dmg", "mas", "linux"];

/**
 * electron-builder replaces the top-level `files` with a platform section's
 * `files`, and a list of exclusions only gets "**\/*" put in front of it. A
 * `win.files` holding one exclusion therefore packed the whole repository into
 * app.asar from 0.25.0 to 0.26.1. The Read Aloud workers then resolved to a
 * path inside app.asar that PowerShell cannot open, and the shortcut read the
 * old clipboard instead of the selection.
 */
describe("files packed into app.asar", () => {
  test("no platform section carries its own files list", () => {
    const withFiles = PLATFORM_SECTIONS.filter((name) => config[name]?.files !== undefined);
    expect(withFiles).toEqual([]);
  });

  test("the top-level list names what ships instead of excluding from everything", () => {
    const included = (config.files as string[]).filter((pattern) => !pattern.startsWith("!"));
    expect(included).toContain("main.js");
    expect(included).toContain("src/helpers/**/*");
    expect(included.some((pattern) => pattern.startsWith("**"))).toBe(false);
  });

  test("the Windows build still leaves out the Mac and Linux SQLite binaries", () => {
    expect(config.files).toContain(
      "!**/node_modules/better-sqlite3/prebuilds/{darwin,linux,linuxmusl}-*.node"
    );
  });
});
