import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, afterEach, describe, expect, it } from "vitest";

/**
 * A TEMP path with a space or a letter outside ASCII used to send dictation audio to
 * C:\ProgramData\PrivateTranscribe\temp, which every account on the PC can read. It now
 * stays in the user's own temp folder, and the old folder loses this user's leftovers.
 */

const { getSafeTempDir, removeLegacySharedTemp } = require("../../../src/helpers/safeTempDir");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "pt-safe-temp-"));

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("getSafeTempDir", () => {
  const realPlatform = process.platform;
  const saved = { TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR };

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: realPlatform, configurable: true });
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it.each(["Søren", "Ωmega", "John Smith"])(
    "keeps a Windows user's own temp folder under %s",
    (name) => {
      const temp = path.join(root, "Users", name, "AppData", "Local", "Temp");
      fs.mkdirSync(temp, { recursive: true });
      Object.defineProperty(process, "platform", { value: "win32", configurable: true });
      // os.tmpdir() reads TEMP on Windows and TMPDIR elsewhere.
      process.env.TEMP = temp;
      process.env.TMP = temp;
      process.env.TMPDIR = temp;

      expect(getSafeTempDir()).toBe(temp);
    }
  );
});

describe("removeLegacySharedTemp", () => {
  function legacyFolder(owner: string) {
    const dir = path.join(root, owner, "ProgramData", "PrivateTranscribe", "temp");
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  /** A folder of the user's own that another account aims a link at. */
  function victimFolder(owner: string) {
    const dir = path.join(root, owner, "Users", "Søren", "Documents");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "whisper-input-1760900000000.webm");
    fs.writeFileSync(file, "the user's own file");
    return { dir, file };
  }

  it("removes this app's leftover audio and keeps everything else", async () => {
    const dir = legacyFolder("Ωmega");
    fs.writeFileSync(path.join(dir, "whisper-input-1760900000000.webm"), "audio");
    fs.writeFileSync(
      path.join(dir, "whisper-output-1b4e28ba-2fa1-41d2-883f-0016d3cca427.wav"),
      "audio"
    );
    fs.writeFileSync(path.join(dir, "whisper-notes.txt"), "not a name we used");
    fs.writeFileSync(path.join(dir, "notes.txt"), "not ours");
    fs.mkdirSync(path.join(dir, "parakeet-audio-AbC123"));
    fs.writeFileSync(path.join(dir, "parakeet-audio-AbC123", "input.wav"), "audio");

    const removed = await removeLegacySharedTemp({ platform: "win32", dirs: [dir] });

    expect(removed).toBe(2);
    expect(fs.readdirSync(dir).sort()).toEqual([
      "notes.txt",
      "parakeet-audio-AbC123",
      "whisper-notes.txt",
    ]);
    expect(fs.existsSync(path.join(dir, "parakeet-audio-AbC123", "input.wav"))).toBe(true);
  });

  it("never follows a link another account planted under one of our names", async () => {
    const dir = legacyFolder("link-in-folder");
    const victim = victimFolder("link-in-folder");
    fs.symlinkSync(victim.dir, path.join(dir, "whisper-input-1760900000001.webm"), "junction");

    expect(await removeLegacySharedTemp({ platform: "win32", dirs: [dir] })).toBe(0);
    expect(fs.readFileSync(victim.file, "utf8")).toBe("the user's own file");
  });

  it("skips a shared folder that is itself a link", async () => {
    const victim = victimFolder("linked-folder");
    const parent = path.join(root, "linked-folder", "ProgramData", "PrivateTranscribe");
    fs.mkdirSync(parent, { recursive: true });
    const dir = path.join(parent, "temp");
    fs.symlinkSync(victim.dir, dir, "junction");

    expect(await removeLegacySharedTemp({ platform: "win32", dirs: [dir] })).toBe(0);
    expect(fs.readFileSync(victim.file, "utf8")).toBe("the user's own file");
  });

  it("removes the folders once they are empty", async () => {
    const dir = legacyFolder("Søren");
    fs.writeFileSync(
      path.join(dir, "whisper-trimmed-1b4e28ba-2fa1-41d2-883f-0016d3cca427.wav"),
      "a"
    );

    expect(await removeLegacySharedTemp({ platform: "win32", dirs: [dir] })).toBe(1);
    expect(fs.existsSync(dir)).toBe(false);
    expect(fs.existsSync(path.dirname(dir))).toBe(false);
  });

  it("does nothing off Windows or when the folders are absent", async () => {
    const dir = legacyFolder("李雷");
    const file = path.join(dir, "whisper-input-1760900000002.webm");
    fs.writeFileSync(file, "audio");

    expect(await removeLegacySharedTemp({ platform: "linux", dirs: [dir] })).toBe(0);
    expect(fs.existsSync(file)).toBe(true);
    expect(
      await removeLegacySharedTemp({ platform: "win32", dirs: [path.join(root, "absent", "temp")] })
    ).toBe(0);
  });
});
