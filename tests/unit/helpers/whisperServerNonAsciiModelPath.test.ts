import { EventEmitter } from "node:events";
import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * whisper-server reads --model through the ANSI code page. For a user named
 * Søren it aborted with 0xC0000409 before loading anything, and "Ωmega" became
 * "Omega", a folder that does not exist. A model path outside ASCII now starts
 * the server in the model's folder with the bare file name.
 */

const WhisperServerManager = require("../../../src/helpers/whisperServer");
const { getModelsDirForService } = require("../../../src/helpers/modelDirUtils");

// Built with the host's path module, which is what the manager splits it with.
const BINARY = path.join("C:", "PrivateTranscribe", "resources", "bin", "whisper-server.exe");

function fakeChild() {
  const child: any = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.pid = undefined;
  child.exitCode = 0;
  child.killed = false;
  return child;
}

/** Captures the spawn instead of starting a process. */
function stubLaunch(manager: any) {
  const spawned: { args: string[]; options: any }[] = [];
  vi.spyOn(manager, "findAvailablePort").mockResolvedValue(1);
  vi.spyOn(manager, "getFFmpegPath").mockReturnValue(null);
  vi.spyOn(manager, "startHealthCheck").mockImplementation(() => {});
  vi.spyOn(manager, "_scheduleIdleCheck").mockImplementation(() => {});
  vi.spyOn(manager, "checkHealth").mockResolvedValue(true);
  vi.spyOn(manager, "_spawnServer").mockImplementation((...call: unknown[]) => {
    spawned.push({ args: call[1] as string[], options: call[2] });
    return fakeChild();
  });
  return spawned;
}

function modelArgument(args: string[]) {
  return args[args.indexOf("--model") + 1];
}

describe("whisper-server launch with a non-ASCII model folder", () => {
  const realPlatform = process.platform;

  beforeEach(() => {
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: realPlatform, configurable: true });
    vi.restoreAllMocks();
  });

  it.each([
    ["Søren", "C:\\Users\\Søren\\.cache\\PrivateTranscribe\\whisper-models"],
    ["Ωmega", "C:\\Users\\Ωmega\\.cache\\PrivateTranscribe\\whisper-models"],
  ])("starts in %s's model folder with the bare file name", async (_name, folder) => {
    const manager: any = new WhisperServerManager();
    const spawned = stubLaunch(manager);

    await manager._startWithBinary(BINARY, `${folder}\\ggml-base.bin`);

    expect(spawned).toHaveLength(1);
    expect(modelArgument(spawned[0].args)).toBe("ggml-base.bin");
    expect(spawned[0].options.cwd).toBe(folder);
    expect(manager.getLastSpawn().cwd).toBe(folder);
    // The binary folder stays on PATH for the engine's own DLLs.
    expect(spawned[0].options.env.PATH.split(";")).toContain(path.dirname(BINARY));
  });

  it("keeps an ASCII model path whole and starts in the binary folder", async () => {
    const manager: any = new WhisperServerManager();
    const spawned = stubLaunch(manager);
    const model = "C:\\Users\\KT\\.cache\\PrivateTranscribe\\whisper-models\\ggml-base.bin";

    await manager._startWithBinary(BINARY, model);

    expect(modelArgument(spawned[0].args)).toBe(model);
    expect(spawned[0].options.cwd).toBe(path.dirname(BINARY));
  });
});

// The real engine on a real Søren folder, where the binary and a model are on
// this machine (a developer checkout after `npm run dev`; never in CI).
const realBinary =
  process.platform === "win32" ? new WhisperServerManager().getCpuServerBinaryPath() : null;
const realModel = (() => {
  const dir = getModelsDirForService("whisper");
  if (!realBinary || !fs.existsSync(dir)) return null;
  const models = fs
    .readdirSync(dir)
    .filter((name: string) => /^ggml-.*\.bin$/.test(name))
    .map((name: string) => path.join(dir, name))
    .sort((a: string, b: string) => fs.statSync(a).size - fs.statSync(b).size);
  return models[0] || null;
})();

describe.runIf(realBinary && realModel)("real whisper-server under a Søren folder", () => {
  // Made in beforeAll: Vitest runs a skipped describe's body but not its afterAll.
  let root = "";
  let folder = "";
  let model = "";
  let manager: any = null;

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "pt-whisper-soren-"));
    folder = path.join(root, "Users", "Søren", ".cache", "PrivateTranscribe", "whisper-models");
    model = path.join(folder, path.basename(realModel || "ggml-base.bin"));
  });

  afterAll(async () => {
    await manager?.stop();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it("loads the model and answers health checks", async () => {
    fs.mkdirSync(folder, { recursive: true });
    try {
      fs.linkSync(realModel as string, model);
    } catch {
      fs.copyFileSync(realModel as string, model);
    }

    manager = new WhisperServerManager();
    await manager._startWithBinary(realBinary, model);

    expect(manager.ready).toBe(true);
    expect(await manager.checkHealth()).toBe(true);
    expect(manager.getLastSpawn().cwd).toBe(folder);
  }, 120_000);
});
