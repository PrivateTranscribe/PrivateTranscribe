import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

/**
 * The withdrawn feature that kept running, pinned.
 *
 * "Pause media while recording" was disabled on Windows because it was not
 * reliable enough — but only in the Settings UI, which stopped drawing the
 * toggle and left `pauseMediaOnRecord=true` sitting in localStorage for
 * everyone who had already switched it on. The renderer read that value, the
 * main process obeyed it, and dictations went on pausing media and firing a
 * global VK_MEDIA_PLAY_PAUSE through nircmd, with no control left in the UI to
 * stop it. Kristian's own debug logs show `pauseMedia() invoked` months after
 * the feature was supposedly off.
 *
 * So the gate belongs in the main process. These tests hold it there:
 * a platform that is not supported must send no media command at all, no
 * matter what the renderer asks for.
 *
 * Nothing here plays or pauses anything. The Windows path proves itself by the
 * PowerShell script it would have to write to the temp directory first — if
 * that file never appears, no PowerShell ran and no media key was sent.
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const mediaController = require("../../../src/helpers/mediaController.js");
const { pauseMedia, resumeMedia, isMediaPauseSupported } = mediaController;

const PAUSE_SCRIPT = path.join(os.tmpdir(), "pt_smtc_pause.ps1");
const RESUME_SCRIPT = path.join(os.tmpdir(), "pt_smtc_resume.ps1");

function forgetScripts() {
  for (const script of [PAUSE_SCRIPT, RESUME_SCRIPT]) {
    try {
      fs.unlinkSync(script);
    } catch {
      // Never written, or left by a real run. Either way it is gone now.
    }
  }
}

const realPlatform = process.platform;

function pretendPlatform(platform: string) {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

afterEach(() => {
  Object.defineProperty(process, "platform", { value: realPlatform, configurable: true });
});

describe("media pause platform support", () => {
  test("Windows is not supported, macOS and Linux are", () => {
    expect(isMediaPauseSupported("win32")).toBe(false);
    expect(isMediaPauseSupported("darwin")).toBe(true);
    expect(isMediaPauseSupported("linux")).toBe(true);
  });

  test("defaults to the running platform", () => {
    pretendPlatform("win32");
    expect(isMediaPauseSupported()).toBe(false);
    pretendPlatform("darwin");
    expect(isMediaPauseSupported()).toBe(true);
  });
});

describe("pauseMedia on an unsupported platform", () => {
  test("writes no SMTC script, so no PowerShell and no media key can run", async () => {
    // Guard first: if the gate were gone, this assertion fails before anything
    // below can touch the machine's media session.
    expect(isMediaPauseSupported("win32")).toBe(false);

    pretendPlatform("win32");
    forgetScripts();

    await pauseMedia();
    expect(fs.existsSync(PAUSE_SCRIPT)).toBe(false);

    await resumeMedia();
    expect(fs.existsSync(RESUME_SCRIPT)).toBe(false);
  });

  test("resumeMedia stays a no-op even after a pause was requested", async () => {
    expect(isMediaPauseSupported("win32")).toBe(false);

    pretendPlatform("win32");
    forgetScripts();

    await pauseMedia();
    await resumeMedia();

    expect(fs.existsSync(PAUSE_SCRIPT)).toBe(false);
    expect(fs.existsSync(RESUME_SCRIPT)).toBe(false);
  });
});
