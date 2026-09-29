import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { test, expect } from "./fixtures/electron-app";

test("native speaker worker survives the AMI crash regression", async ({ electronApp }) => {
  test.skip(
    process.env.PT_REAL_SPEAKERS !== "1",
    "Requires installed speaker models and speaker-benchmark prepare"
  );
  test.setTimeout(180_000);
  const audio = path.resolve("tmp/speaker-comparison/cases/ES2004a-0060-0180/audio.wav");
  expect(crypto.createHash("sha256").update(fs.readFileSync(audio)).digest("hex")).toBe(
    "2a986388a7ee332acbd0a4be53501a02b45e7109032a4ceb8260ceb924242a2b"
  );
  const result = await electronApp.evaluate(async ({ app }, audio) => {
    const { createRequire } = (process as any).getBuiltinModule("module");
    const mainRequire = createRequire(`${app.getAppPath()}/main.js`);
    const { DiarizationManager } = mainRequire("./src/helpers/diarizationManager.js");
    const manager = new DiarizationManager();
    if (!manager.getModelStatus().ready) throw new Error("Install local speaker models first");
    return manager.diarizeWavFileInWorker(audio, { signal: AbortSignal.timeout(120_000) });
  }, audio);
  expect(result.success).toBe(true);
  expect(result.durationSec).toBeCloseTo(120, 1);
  expect(result.segments.length).toBeGreaterThan(0);
  for (const segment of result.segments) {
    expect(Number.isFinite(segment.start)).toBe(true);
    expect(segment.end).toBeGreaterThan(segment.start);
    expect(segment.end).toBeLessThanOrEqual(120);
  }
});
