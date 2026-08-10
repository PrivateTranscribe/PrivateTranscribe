import { describe, expect, test } from "vitest";
import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const voiceMuter = require("../../../src/helpers/voiceMuter");
const { VoiceMuter, getHoldKeyExecutablePaths, resolveHoldKeyExecutable } = voiceMuter;

describe("hold key executable resolution", () => {
  test("prefers the packaged resources directory over the dev layouts", () => {
    const paths = getHoldKeyExecutablePaths({
      resourcesPath: "C:\\app\\resources",
      cwd: "C:\\dev\\project",
      helpersDir: "C:\\dev\\project\\src\\helpers",
    });
    expect(paths[0]).toContain("C:\\app\\resources");
    expect(paths.length).toBeGreaterThan(1);
  });

  test("returns null when the helper is nowhere to be found", () => {
    expect(resolveHoldKeyExecutable({ existsSync: () => false })).toBeNull();
  });
});

describe("VoiceMuter release safety", () => {
  test("release does nothing when we never muted", async () => {
    // The rule that keeps the feature from unmuting somebody who muted
    // themselves: we only ever undo a mute we performed.
    const muter = new VoiceMuter();
    expect(muter.isMuted()).toBe(false);
    await expect(muter.release()).resolves.toBe(false);
  });

  test("hold reports failure rather than a false success when unsupported", async () => {
    const muter = new VoiceMuter();
    muter.isSupported = false;
    await expect(muter.hold("F13")).resolves.toBe(false);
    expect(muter.isMuted()).toBe(false);
  });

  test("hold refuses an empty key instead of pressing something arbitrary", async () => {
    const muter = new VoiceMuter();
    await expect(muter.hold("")).resolves.toBe(false);
    await expect(muter.hold(null)).resolves.toBe(false);
    expect(muter.isMuted()).toBe(false);
  });

  test("a second hold does not stack a second key press", async () => {
    // Two presses would need two releases to balance. If the second release
    // never came the key would stay logically down system-wide.
    const muter = new VoiceMuter();
    muter.process = { fake: true };
    muter.heldKey = "F13";
    await expect(muter.hold("F13")).resolves.toBe(true);
    expect(muter.process).toEqual({ fake: true });
  });
});

/**
 * The picker and the helper are two separate key vocabularies: one built from
 * KeyboardEvent.code, the other from the .NET Keys enum. When they disagree the
 * helper exits without pressing anything and the user dictates into a live call
 * believing they are muted, so the two lists have to be checked against each
 * other rather than assumed to match.
 *
 * This drives the real executable because the helper's parser is the authority.
 * A mirrored list in TypeScript would just be a second thing to keep in sync.
 */
describe("every key the picker can emit is one the helper can press", () => {
  const exePath = path.join(__dirname, "..", "..", "..", "resources", "bin", "windows-hold-key.exe");
  const runnable = process.platform === "win32" && fs.existsSync(exePath);

  test.runIf(runnable)("no picker key name is rejected by the helper", () => {
    const source = fs.readFileSync(
      path.join(__dirname, "..", "..", "..", "src", "components", "ui", "HotkeyInput.tsx"),
      "utf8"
    );
    const table = source.slice(
      source.indexOf("const CODE_TO_KEY"),
      source.indexOf("const MODIFIER_CODES")
    );

    const names = new Set<string>();
    const quoted = /:\s*("(?:[^"\\]|\\.)*")/g;
    let match: RegExpExecArray | null;
    while ((match = quoted.exec(table)) !== null) {
      names.add(JSON.parse(match[1]) as string);
    }
    // The mouse and modifier capture paths bypass CODE_TO_KEY.
    ["Mouse3", "Mouse4", "Mouse5", "CommandOrControl", "Alt", "Shift", "Super"].forEach((name) =>
      names.add(name)
    );

    expect(names.size).toBeGreaterThan(100);

    // --release-only parses the key and sends the key-up half, which is a no-op
    // for a key that is already up. Exit 3 means the parse failed.
    const rejected = [...names].filter(
      (name) => spawnSync(exePath, [`--key=${name}`, "--release-only"]).status !== 0
    );
    expect(rejected).toEqual([]);
  });
});
