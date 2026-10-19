/**
 * The speaker worker runs as the installed app's own executable with
 * ELECTRON_RUN_AS_NODE=1, and an installed build ships no electron package. In
 * 0.23.0 the worker imported debugLogger and modelDirUtils, which require
 * electron, so it died with MODULE_NOT_FOUND for every installed user while
 * development builds, which resolve electron from node_modules, worked.
 *
 * These runs start the real worker through DiarizationManager under plain Node
 * with electron made unresolvable by tests/fixtures/no-electron-preload.cjs.
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const {
  DiarizationManager,
  DEFAULT_EMBEDDING_RELATIVE_PATH,
  DEFAULT_SEGMENTATION_RELATIVE_PATH,
} = require("../../../src/helpers/diarizationManager");

const PRELOAD = path.resolve(__dirname, "../../fixtures/no-electron-preload.cjs");
const tempDirs: string[] = [];

function makeModelsDir({ withModels }: { withModels: boolean }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-diarization-worker-"));
  tempDirs.push(dir);
  if (withModels) {
    const segmentation = path.join(dir, DEFAULT_SEGMENTATION_RELATIVE_PATH);
    fs.mkdirSync(path.dirname(segmentation), { recursive: true });
    fs.writeFileSync(segmentation, "segmentation");
    fs.writeFileSync(path.join(dir, DEFAULT_EMBEDDING_RELATIVE_PATH), "embedding");
  }
  return dir;
}

/** The manager's spawn, with the preload added and the fake engine on or off. */
function spawnWithoutElectron({ fakeSherpa }: { fakeSherpa: boolean }) {
  return vi.fn((exe: string, args: string[], options: any) =>
    spawn(exe, ["--require", PRELOAD, ...args], {
      ...options,
      env: { ...options.env, PT_TEST_FAKE_SHERPA: fakeSherpa ? "1" : "" },
    })
  );
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("diarization worker without Electron", () => {
  it("cannot load debugLogger under the preload, as in an installed build", () => {
    const debugLogger = path.resolve(__dirname, "../../../src/helpers/debugLogger.js");
    const run = spawnSync(
      process.execPath,
      ["--require", PRELOAD, "-e", `require(${JSON.stringify(debugLogger)})`],
      { encoding: "utf8" }
    );

    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("Cannot find module 'electron'");
  });

  it("returns speaker turns, finding the models through its payload", async () => {
    const modelsDir = makeModelsDir({ withModels: true });
    const spawnChild = spawnWithoutElectron({ fakeSherpa: true });
    const manager = new DiarizationManager({ modelsDir, spawn: spawnChild });

    const result = await manager.diarizeWavFileInWorker("unused.wav", {});

    expect(spawnChild).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      success: true,
      engine: "sherpa-onnx",
      speakerCount: 2,
      speakers: ["SPEAKER_00", "SPEAKER_01"],
      model: { segmentation: path.join(modelsDir, DEFAULT_SEGMENTATION_RELATIVE_PATH) },
    });
    expect(result.segments.map((segment: any) => [segment.start, segment.end])).toEqual([
      [0, 4.5],
      [4.5, 9.5],
    ]);
  });

  it("reports its own failure instead of dying at startup", async () => {
    const manager = new DiarizationManager({
      modelsDir: makeModelsDir({ withModels: false }),
      spawn: spawnWithoutElectron({ fakeSherpa: false }),
    });

    await expect(manager.diarizeWavFileInWorker("unused.wav", {})).rejects.toThrow(
      /^Diarization models are not downloaded yet/
    );
  });
});
