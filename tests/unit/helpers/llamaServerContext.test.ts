import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * llama-server reserves the key-value cache for its whole context window when it
 * starts. Warm-up once started it with the model's trained window of 131,072
 * tokens, and every later cleanup reused that server. Every start now uses one
 * bounded window.
 *
 * child_process inside src/helpers is CommonJS that vi.mock cannot replace, so
 * the spawn goes through the manager's _spawnServer seam.
 */

const LlamaServerManager = require("../../../src/helpers/llamaServer");
const modelManager = require("../../../src/helpers/modelManagerBridge").default;
const registry = require("../../../src/models/modelRegistryData.json");

const QWEN3_8B = "qwen3-8b-q4_k_m";

function fakeChild() {
  const child: any = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.pid = undefined;
  // Already exited as far as killProcess is concerned, so stop() never signals
  // a real process that happens to share a pid.
  child.exitCode = 0;
  child.killed = false;
  return child;
}

/** Starts the server without a binary or a port, and records each command line. */
function stubLaunch(server: any, binDir: string) {
  const spawned: string[][] = [];
  vi.spyOn(server, "getServerBinaryPath").mockReturnValue(path.join(binDir, "llama-server"));
  vi.spyOn(server, "findAvailablePort").mockResolvedValue(8200);
  vi.spyOn(server, "_spawnServer").mockImplementation((...call: unknown[]) => {
    spawned.push((call as [string, string[]])[1]);
    return fakeChild();
  });
  vi.spyOn(server, "waitForReady").mockImplementation(async () => {
    server.ready = true;
  });
  vi.spyOn(server, "startHealthCheck").mockImplementation(() => {});
  vi.spyOn(server, "_scheduleIdleCheck").mockImplementation(() => {});
  return spawned;
}

const ctxSize = (args: string[]) => Number(args[args.indexOf("--ctx-size") + 1]);

async function stopServer(server: any) {
  const child = server.process;
  const stopping = server.stop();
  child?.emit("close", 0);
  await stopping;
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-llama-ctx-"));
});

afterEach(async () => {
  await stopServer(modelManager.serverManager);
  modelManager.currentServerModelId = null;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("llama-server context window", () => {
  it("starts every server with the one context size, whatever a caller asks for", async () => {
    const modelPath = path.join(tmpDir, "model.gguf");
    fs.writeFileSync(modelPath, "not really a model");
    const server = new LlamaServerManager();
    const spawned = stubLaunch(server, tmpDir);

    await server.start(modelPath, { contextSize: 131072 });

    expect(ctxSize(spawned[0])).toBe(16384);
    expect(server.getStatus().contextSize).toBe(16384);
    await stopServer(server);
  });

  it("warms up with the cleanup context, and a long cleanup reuses that server", async () => {
    const model = registry.localProviders
      .flatMap((p: any) => p.models)
      .find((m: any) => m.id === QWEN3_8B);
    fs.writeFileSync(path.join(tmpDir, model.fileName), "not really a model");
    vi.spyOn(modelManager, "ensureInitialized").mockImplementation(() => {});
    vi.spyOn(modelManager, "checkModelValid").mockResolvedValue(true);
    modelManager.modelsDir = tmpDir;
    const spawned = stubLaunch(modelManager.serverManager, tmpDir);
    const inference = vi
      .spyOn(modelManager.serverManager, "inference")
      .mockResolvedValue("Clean text.");

    expect(await modelManager.prewarmServer(QWEN3_8B)).toBe(true);
    await modelManager.runInference(QWEN3_8B, "word ".repeat(12_000), {
      systemPrompt: "Clean this.",
      maxTokens: 4096,
    });

    expect(spawned).toHaveLength(1);
    expect(ctxSize(spawned[0])).toBe(16384);
    expect(inference).toHaveBeenCalledTimes(1);
  });
});
