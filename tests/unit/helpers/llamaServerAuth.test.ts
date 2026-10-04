import { EventEmitter } from "node:events";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * llama-server answers anyone who can reach its port, web pages included,
 * unless it is started with an API key. Each start makes a fresh key, hands it
 * over in the environment, and sends it on every request.
 *
 * child_process inside src/helpers is CommonJS that vi.mock cannot replace, so
 * the spawn goes through the manager's _spawnServer seam and a local HTTP
 * server stands in for llama-server.
 */

const LlamaServerManager = require("../../../src/helpers/llamaServer");
const debugLogger = require("../../../src/helpers/debugLogger");

type Seen = { method?: string; url?: string; authorization?: string };
type Spawned = { args: string[]; env: Record<string, string> };

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

let tmpDir: string;
let modelPath: string;
let server: http.Server | null = null;
let manager: any;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-llama-auth-"));
  modelPath = path.join(tmpDir, "model.gguf");
  fs.writeFileSync(modelPath, "not really a model");
  manager = new LlamaServerManager();
});

afterEach(async () => {
  await stopManager();
  if (server) {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Answers like llama-server, and remembers what each request carried. */
async function startFakeLlama(seen: Seen[]) {
  server = http.createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, authorization: req.headers.authorization });
    req.resume();
    req.on("end", () => {
      const body =
        req.url === "/v1/chat/completions"
          ? { choices: [{ message: { content: "Rettet tekst." }, finish_reason: "stop" }] }
          : { status: "ok" };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Failed to start test server");
  return address.port;
}

function stubLaunch(port: number) {
  const spawned: Spawned[] = [];
  vi.spyOn(manager, "getServerBinaryPath").mockReturnValue(path.join(tmpDir, "llama-server"));
  vi.spyOn(manager, "findAvailablePort").mockResolvedValue(port);
  vi.spyOn(manager, "_spawnServer").mockImplementation((...call: unknown[]) => {
    const [, args, options] = call as [string, string[], { env: Record<string, string> }];
    spawned.push({ args, env: options.env });
    return fakeChild();
  });
  return spawned;
}

async function stopManager() {
  const child = manager?.process;
  const stopping = manager?.stop();
  child?.emit("close", 0);
  await stopping;
}

describe("llama-server API key", () => {
  it("hands a fresh key to the server in its environment, never on the command line", async () => {
    const port = await startFakeLlama([]);
    const spawned = stubLaunch(port);

    await manager.start(modelPath);

    const key = spawned[0].env.LLAMA_API_KEY;
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(manager.apiKey).toBe(key);
    expect(spawned[0].args.join(" ")).not.toContain(key);
    expect(spawned[0].args).not.toContain("--api-key");
    // The rest of the environment still reaches the server.
    expect(spawned[0].env.PATH ?? spawned[0].env.Path).toBe(process.env.PATH ?? process.env.Path);
  });

  it("turns off the slots endpoint and the web page, and names the model by an alias", async () => {
    const port = await startFakeLlama([]);
    const spawned = stubLaunch(port);

    await manager.start(modelPath);

    const { args } = spawned[0];
    expect(args).toContain("--no-slots");
    expect(args).toContain("--no-webui");
    expect(args[args.indexOf("--alias") + 1]).toBe("privatetranscribe-local");
  });

  it("sends the key on the health check and on every completion request", async () => {
    const seen: Seen[] = [];
    const port = await startFakeLlama(seen);
    const spawned = stubLaunch(port);

    await manager.start(modelPath);
    const text = await manager.inference([{ role: "user", content: "ret den her tekst" }]);
    await manager.inference([{ role: "user", content: "og den her" }]);

    const key = spawned[0].env.LLAMA_API_KEY;
    expect(text).toBe("Rettet tekst.");
    expect(seen.map((request) => `${request.method} ${request.url}`)).toEqual(
      expect.arrayContaining(["GET /health", "POST /v1/chat/completions"])
    );
    expect(seen.filter((request) => request.url === "/v1/chat/completions")).toHaveLength(2);
    for (const request of seen) {
      expect(request.authorization).toBe(`Bearer ${key}`);
    }
  });

  it("makes a new key for every start and forgets it on stop", async () => {
    const port = await startFakeLlama([]);
    const spawned = stubLaunch(port);

    await manager.start(modelPath);
    await stopManager();
    expect(manager.apiKey).toBeNull();

    await manager.start(modelPath);

    expect(spawned).toHaveLength(2);
    expect(spawned[1].env.LLAMA_API_KEY).toMatch(/^[0-9a-f]{64}$/);
    expect(spawned[1].env.LLAMA_API_KEY).not.toBe(spawned[0].env.LLAMA_API_KEY);
    expect(manager.apiKey).toBe(spawned[1].env.LLAMA_API_KEY);
  });

  it("never writes the key to the log", async () => {
    const logged: string[] = [];
    vi.spyOn(debugLogger, "write").mockImplementation((...call: unknown[]) => {
      logged.push(JSON.stringify(call));
    });
    const port = await startFakeLlama([]);
    const spawned = stubLaunch(port);

    await manager.start(modelPath);
    await manager.inference([{ role: "user", content: "hej" }]);
    const key = spawned[0].env.LLAMA_API_KEY;
    await stopManager();

    // The start and its arguments were logged; the key was not.
    expect(logged.some((line) => line.includes("--no-slots"))).toBe(true);
    expect(logged.join("\n")).not.toContain(key);
  });
});
