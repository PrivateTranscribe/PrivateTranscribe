import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * Each transcription deletes its own temp audio, so only a crash or a killed
 * process leaves any. Nothing removed those files from the user's own temp
 * folder, so a crash kept the dictation audio on disk for good.
 */

const { removeLeftoverTempAudio } = require("../../../src/helpers/safeTempDir");

const UUID = "3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b";
const DAY_MS = 24 * 60 * 60 * 1000;

let dir: string;
const now = Date.now();

function make(name: string, ageMs: number, { folder = false } = {}) {
  const target = path.join(dir, name);
  if (folder) {
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, "input.wav"), "audio");
  } else {
    fs.writeFileSync(target, "audio");
  }
  const when = new Date(now - ageMs);
  fs.utimesSync(target, when, when);
  return target;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-leftover-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("removeLeftoverTempAudio", () => {
  it("removes the app's own audio left behind more than a day ago", async () => {
    const stale = [
      make(`whisper-input-${UUID}.webm`, 2 * DAY_MS),
      make(`whisper-output-${UUID}.wav`, 2 * DAY_MS),
      make(`whisper-trimmed-${UUID}.wav`, 2 * DAY_MS),
      make(`privatetranscribe-diarization-${UUID}.wav`, 2 * DAY_MS),
      make("parakeet-audio-Ab12Cd", 2 * DAY_MS, { folder: true }),
    ];

    await expect(removeLeftoverTempAudio({ dir, now })).resolves.toBe(stale.length);
    for (const file of stale) expect(fs.existsSync(file)).toBe(false);
  });

  it("leaves a transcription that may still be running alone", async () => {
    // Another copy of the app (a test run has its own profile) can be
    // transcribing a long file right now.
    const fresh = [
      make(`whisper-input-${UUID}.webm`, 60 * 60 * 1000),
      make("parakeet-audio-Ab12Cd", 60 * 60 * 1000, { folder: true }),
    ];

    await expect(removeLeftoverTempAudio({ dir, now })).resolves.toBe(0);
    for (const file of fresh) expect(fs.existsSync(file)).toBe(true);
  });

  it("leaves files the app did not name alone, however old", async () => {
    const others = [
      make("whisper-notes.wav", 2 * DAY_MS),
      make(`whisper-input-${UUID}.webm.bak`, 2 * DAY_MS),
      make("parakeet-audio-notes", 2 * DAY_MS),
      make("recording.wav", 2 * DAY_MS),
    ];

    await expect(removeLeftoverTempAudio({ dir, now })).resolves.toBe(0);
    for (const file of others) expect(fs.existsSync(file)).toBe(true);
  });

  it("never throws on a folder it cannot read", async () => {
    await expect(removeLeftoverTempAudio({ dir: path.join(dir, "missing"), now })).resolves.toBe(0);
  });
});
