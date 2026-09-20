import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
const { prepareSpeechPcm, MODEL_SHA256 } = require("../../../src/helpers/dictationSpeech");
const {
  prepareDictationSpeech,
  resolveSpeechModelPath,
} = require("../../../src/helpers/dictationSpeechRunner");
const { readPcm } = require("../../../scripts/benchmark-dictation-endings");

const SR = 16000;
const audio = (seconds: number) => Buffer.alloc(seconds * SR * 2, 10);

describe("dictation speech boundaries", () => {
  it("preserves all audio when no speech was detected", () => {
    const pcm = audio(10);
    const result = prepareSpeechPcm(pcm, []);
    expect(result.mode).toBe("unchanged");
    expect(result.pcm).toBe(pcm);
  });
  it("trims a short noise tail without changing speech or interior timing", () => {
    const pcm = audio(10);
    const prepared = prepareSpeechPcm(pcm, [{ start: SR, end: 9 * SR }]);
    expect(prepared.mode).toBe("tail");
    expect(prepared.pcm.length).toBe(9.5 * SR * 2);
    expect(prepared.pcm.equals(pcm.subarray(0, 9.5 * SR * 2))).toBe(true);
  });
  it("merges padded overlaps so one word cannot be copied twice", () => {
    const pcm = audio(15);
    const prepared = prepareSpeechPcm(pcm, [
      { start: SR, end: 3 * SR },
      { start: 3.5 * SR, end: 6 * SR },
    ]);
    expect(prepared.mode).toBe("cleanup");
    expect(prepared.regions).toBe(1);
    expect(prepared.pcm.length).toBe(6.5 * SR * 2);
    expect(
      prepared.pcm.subarray(0, 6 * SR * 2).equals(pcm.subarray(0.5 * SR * 2, 6.5 * SR * 2))
    ).toBe(true);
  });
  it("retains padded speech on both sides of a long pause", () => {
    const pcm = audio(20);
    const prepared = prepareSpeechPcm(pcm, [
      { start: SR, end: 3 * SR },
      { start: 16 * SR, end: 19 * SR },
    ]);
    const expected = Buffer.concat([
      pcm.subarray(0.5 * SR * 2, 3.5 * SR * 2),
      Buffer.alloc(SR),
      pcm.subarray(15.5 * SR * 2, 19.5 * SR * 2),
      Buffer.alloc(SR),
    ]);
    expect(prepared.mode).toBe("cleanup");
    expect(prepared.pcm.equals(expected)).toBe(true);
  });
  it.each([
    { start: -1, end: SR },
    { start: SR, end: 0 },
    { start: 0, end: 21 * SR },
  ])("rejects invalid detector boundaries instead of slicing silently", (region) => {
    expect(() => prepareSpeechPcm(audio(20), [region])).toThrow("boundaries");
  });
});

describe("bundled speech detector", () => {
  it("ships the pinned model and configures it as a packaged resource", () => {
    const file = resolveSpeechModelPath();
    expect(file).toBeTruthy();
    expect(crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex")).toBe(
      MODEL_SHA256
    );
    const config = JSON.parse(fs.readFileSync("electron-builder.json", "utf8"));
    expect(config.extraResources).toContainEqual({
      from: "resources/models/silero-vad.onnx",
      to: "models/silero-vad.onnx",
    });
  });
  it("detects real speech in a process without blocking the event loop", async () => {
    const pcm = readPcm(path.resolve("tests/fixtures/dictation/banana.wav"));
    let timerRan = false;
    const timer = setTimeout(() => {
      timerRan = true;
    }, 0);
    const result = await prepareDictationSpeech(pcm);
    clearTimeout(timer);
    expect(timerRan).toBe(true);
    expect(result.available).toBe(true);
    expect(result.regions).toBeGreaterThan(0);
    expect(result.pcm.length).toBeGreaterThan(3 * SR * 2);
  });
  it("falls back when the model is absent or invalid", async () => {
    expect(await prepareDictationSpeech(audio(1), { modelPath: null })).toMatchObject({
      available: false,
    });
    expect(
      await prepareDictationSpeech(audio(1), { modelPath: path.resolve("package.json") })
    ).toMatchObject({ available: false });
  });
  it("cancels a pending process and bounds its runtime", async () => {
    const controller = new AbortController();
    const pending = prepareDictationSpeech(audio(30), { signal: controller.signal });
    controller.abort();
    expect(await pending).toMatchObject({ available: false, reason: "cancelled" });
    expect(await prepareDictationSpeech(audio(30), { timeoutMs: 1 })).toMatchObject({
      available: false,
      reason: "timeout",
    });
  });
});
