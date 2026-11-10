import { EventEmitter } from "node:events";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The local AI cleanup server is unloaded after a quiet period. The clock for
 * that period only moved when an answer came back, so a cleanup that was still
 * being answered when the period ran out had its server stopped under it.
 *
 * Same harness as llamaServerAuth.test.ts: the spawn goes through the
 * manager's _spawnServer seam and a local HTTP server stands in for
 * llama-server.
 */

const LlamaServerManager = require("../../../src/helpers/llamaServer");

const IDLE_MS = 40;

function fakeChild() {
  const child: any = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.pid = undefined;
  // Already exited as far as killProcess is concerned, so stop() never signals
  // or taskkills a real process that happens to share a pid.
  child.exitCode = 0;
  child.killed = false;
  return child;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let tmpDir: string;
let modelPath: string;
let server: http.Server | null = null;
let manager: any;
let releaseAnswer: (() => void) | null = null;
// Called when the client drops a completion request before it was answered.
let onDropped: (() => void) | null = null;

/** Answers the health check at once and holds each completion until released. */
async function startSlowLlama() {
  server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      const answer = (body: unknown) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (req.url !== "/v1/chat/completions") {
        answer({ status: "ok" });
        return;
      }
      res.on("close", () => {
        if (!res.writableEnded) onDropped?.();
      });
      releaseAnswer = () =>
        answer({ choices: [{ message: { content: "Rettet tekst." }, finish_reason: "stop" }] });
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Failed to start test server");
  return address.port;
}

async function startManager() {
  const port = await startSlowLlama();
  vi.spyOn(manager, "getServerBinaryPath").mockReturnValue(path.join(tmpDir, "llama-server"));
  vi.spyOn(manager, "findAvailablePort").mockResolvedValue(port);
  vi.spyOn(manager, "_spawnServer").mockImplementation(() => fakeChild());
  await manager.start(modelPath);
}

async function waitForRequest() {
  for (let i = 0; i < 100 && !releaseAnswer; i++) await sleep(5);
  if (!releaseAnswer) throw new Error("The completion request never arrived");
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-llama-idle-"));
  modelPath = path.join(tmpDir, "model.gguf");
  fs.writeFileSync(modelPath, "not really a model");
  manager = new LlamaServerManager();
  releaseAnswer = null;
  onDropped = null;
});

afterEach(async () => {
  const child = manager?.process;
  const stopping = manager?.stop();
  child?.emit("close", 0);
  await stopping;
  if (server) {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  }
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3 });
});

describe("llama-server idle unload", () => {
  it("leaves the server running while a cleanup is still being answered", async () => {
    await startManager();
    const stop = vi.spyOn(manager, "stop");
    manager.setIdleTimeoutMs(IDLE_MS);

    const cleanup = manager.inference([{ role: "user", content: "ret den her tekst" }]);
    await waitForRequest();
    await sleep(IDLE_MS * 4);

    expect(stop).not.toHaveBeenCalled();
    expect(manager.stoppedDueToIdle).toBe(false);

    releaseAnswer!();
    await expect(cleanup).resolves.toBe("Rettet tekst.");
  });

  it("still unloads the server once the answer is back and the quiet period has passed", async () => {
    await startManager();
    manager.setIdleTimeoutMs(IDLE_MS);

    const cleanup = manager.inference([{ role: "user", content: "ret den her tekst" }]);
    await waitForRequest();
    await sleep(IDLE_MS * 2);
    releaseAnswer!();
    await cleanup;

    const child = manager.process;
    const stop = vi.spyOn(manager, "stop");
    for (let i = 0; i < 100 && stop.mock.calls.length === 0; i++) await sleep(5);
    child.emit("close", 0);

    expect(stop).toHaveBeenCalled();
    expect(manager.stoppedDueToIdle).toBe(true);
  });
});

describe("a llama-server request its caller has given up on", () => {
  it("ends at once and drops the connection", async () => {
    await startManager();
    const dropped = new Promise<void>((resolve) => {
      onDropped = resolve;
    });
    const abort = new AbortController();

    const cleanup = manager.inference([{ role: "user", content: "ret den her tekst" }], {
      signal: abort.signal,
    });
    await waitForRequest();
    abort.abort();

    await expect(cleanup).rejects.toThrow("llama-server request cancelled");
    await dropped;
    expect(manager.activeInferences).toBe(0);
  });

  it("is not sent at all when it was cancelled before it started", async () => {
    await startManager();
    const abort = new AbortController();
    abort.abort();

    await expect(
      manager.inference([{ role: "user", content: "ret den her tekst" }], { signal: abort.signal })
    ).rejects.toThrow("llama-server request cancelled");
    expect(releaseAnswer).toBeNull();
  });
});
