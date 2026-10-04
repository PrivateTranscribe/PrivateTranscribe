import { EventEmitter } from "node:events";
import http from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * whisper-server has no password option. Each launch therefore moves every
 * route under a random path prefix only this app knows, so a web page or
 * another program that finds the port gets a 404 instead of a transcriber.
 *
 * child_process inside src/helpers is CommonJS that vi.mock cannot replace, so
 * the spawn goes through the manager's _spawnServer seam, and a local HTTP
 * server stands in for whisper-server wherever a request crosses the wire.
 */

const WhisperServerManager = require("../../../src/helpers/whisperServer");
const debugLogger = require("../../../src/helpers/debugLogger");

const PREFIX = /^\/pt-[0-9a-f]{32}$/;
const BINARY = "/fake/bin/whisper-server";
const MODEL_PATH = "/models/ggml-base.bin";

type Spawned = { args: string[]; child: any };
type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void;

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

/** Stubs everything around the spawn that would touch this machine. */
function stubLaunch(
  manager: any,
  {
    port = 1,
    healthy = true,
    onSpawn,
  }: {
    port?: number;
    healthy?: boolean | "ask-the-server";
    onSpawn?: (child: any, args: string[]) => void;
  } = {}
) {
  const spawned: Spawned[] = [];
  vi.spyOn(manager, "findAvailablePort").mockResolvedValue(port);
  vi.spyOn(manager, "getFFmpegPath").mockReturnValue(null);
  vi.spyOn(manager, "startHealthCheck").mockImplementation(() => {});
  vi.spyOn(manager, "_scheduleIdleCheck").mockImplementation(() => {});
  if (healthy !== "ask-the-server") vi.spyOn(manager, "checkHealth").mockResolvedValue(healthy);
  vi.spyOn(manager, "_spawnServer").mockImplementation((...call: unknown[]) => {
    const args = call[1] as string[];
    const child = fakeChild();
    spawned.push({ args, child });
    onSpawn?.(child, args);
    return child;
  });
  return spawned;
}

async function stop(manager: any) {
  const child = manager.process;
  const stopping = manager.stop();
  child?.emit("close", 0);
  await stopping;
}

function json(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

/** whisper-server's own answer to a path it does not serve. */
function notFound(req: http.IncomingMessage, res: http.ServerResponse) {
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end(`File Not Found (${req.url})`);
}

const servers: http.Server[] = [];

async function fakeWhisper(handler: Handler) {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => handler(req, res));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Failed to start test server");
  return address.port;
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

describe("whisper-server request path", () => {
  it("launches with a fresh random prefix as the last argument, and drops it on stop", async () => {
    const manager: any = new WhisperServerManager();
    const spawned = stubLaunch(manager);

    await manager._startWithBinary(BINARY, MODEL_PATH);
    const first = manager.requestPathPrefix;
    await stop(manager);
    expect(manager.requestPathPrefix).toBeNull();

    await manager._startWithBinary(BINARY, MODEL_PATH);
    const second = manager.requestPathPrefix;
    await stop(manager);

    expect(first).toMatch(PREFIX);
    expect(second).toMatch(PREFIX);
    expect(second).not.toBe(first);
    expect(spawned[0].args.slice(-2)).toEqual(["--request-path", first]);
    expect(spawned[1].args.slice(-2)).toEqual(["--request-path", second]);
  });

  it("asks for health and inference under the prefix, and nowhere else", async () => {
    const manager: any = new WhisperServerManager();
    const urls: string[] = [];
    const port = await fakeWhisper((req, res) => {
      urls.push(req.url ?? "");
      const prefix = manager.requestPathPrefix;
      if (req.url === `${prefix}/health`) return json(res, 200, { status: "ok" });
      if (req.url === `${prefix}/inference`) return json(res, 200, { text: "hej" });
      notFound(req, res);
    });
    stubLaunch(manager, { port, healthy: "ask-the-server" });

    await manager._startWithBinary(BINARY, MODEL_PATH);
    const prefix = manager.requestPathPrefix;
    const result = await manager._postInference(Buffer.from("wav"), { durationSeconds: 1 });
    await stop(manager);

    expect(result).toMatchObject({ text: "hej" });
    expect(urls).toContain(`${prefix}/health`);
    expect(urls).toContain(`${prefix}/inference`);
    expect(urls.every((url) => url.startsWith(`${prefix}/`))).toBe(true);
  });

  it("does not count a server that lacks this launch's prefix as ready", async () => {
    const manager: any = new WhisperServerManager();
    const urls: string[] = [];
    const port = await fakeWhisper((req, res) => {
      urls.push(req.url ?? "");
      notFound(req, res);
    });
    const stalePrefix = `/pt-${"0".repeat(32)}`;
    manager.port = port;

    manager.requestPathPrefix = stalePrefix;
    await expect(manager.checkHealth()).resolves.toBe(false);

    // With no prefix there is no server of ours, so nobody is asked.
    manager.requestPathPrefix = null;
    await expect(manager.checkHealth()).resolves.toBe(false);

    expect(urls).toEqual([`${stalePrefix}/health`]);
  });

  it("sends no audio when no server of ours is running", async () => {
    const manager: any = new WhisperServerManager();
    const urls: string[] = [];
    const port = await fakeWhisper((req, res) => {
      urls.push(req.url ?? "");
      json(res, 200, { text: "someone else's transcript" });
    });
    manager.port = port;
    manager.ready = true;

    await expect(
      manager._postInference(Buffer.from("wav"), { durationSeconds: 1 })
    ).rejects.toThrow("whisper-server is not running");

    expect(urls).toEqual([]);
    expect(manager.getRecentInferenceRequests()).toHaveLength(0);
  });

  it("keeps the prefix out of logs, the spawn record and error messages", async () => {
    const logged: string[] = [];
    vi.spyOn(debugLogger, "write").mockImplementation((...call: unknown[]) => {
      logged.push(JSON.stringify(call));
    });
    const manager: any = new WhisperServerManager();
    const port = await fakeWhisper((req, res) => {
      if (req.url === `${manager.requestPathPrefix}/health`) return json(res, 200, {});
      notFound(req, res);
    });
    const spawned = stubLaunch(manager, { port, healthy: "ask-the-server" });

    await manager._startWithBinary(BINARY, MODEL_PATH);
    const prefix = manager.requestPathPrefix;
    const secret = prefix.slice("/pt-".length);
    // The usage text whisper-server prints after a rejected argument shows the value.
    spawned[0].child.stderr.emit(
      "data",
      Buffer.from(`  --request-path PATH,  [${prefix}] Request path for all requests\n`)
    );
    const failure = await manager
      ._postInference(Buffer.from("wav"), { durationSeconds: 1 })
      .catch((error: Error) => error);
    const lastSpawn = manager.getLastSpawn();
    await stop(manager);

    expect(spawned[0].args).toContain(prefix);
    expect(lastSpawn.args.slice(-2)).toEqual(["--request-path", "[REDACTED]"]);
    expect(JSON.stringify(lastSpawn)).not.toContain(secret);

    expect(failure).toBeInstanceOf(Error);
    expect(failure.message).toContain("404");
    expect(failure.message).toContain("[REDACTED]");
    expect(failure.message).not.toContain(secret);

    expect(logged.some((line) => line.includes("[REDACTED]"))).toBe(true);
    expect(logged.join("\n")).not.toContain(secret);
  });

  it("keeps the prefix out of the message when the server dies during startup", async () => {
    vi.spyOn(debugLogger, "write").mockImplementation(() => {});
    const manager: any = new WhisperServerManager();
    const spawned = stubLaunch(manager, {
      healthy: false,
      onSpawn: (child, args) => {
        setImmediate(() => {
          child.stderr.emit(
            "data",
            Buffer.from(
              `error: unknown argument: --bogus\n  --request-path PATH,  [${args.at(-1)}] Request path\n`
            )
          );
          child.emit("close", 1);
        });
      },
    });

    const failure = await manager
      ._startWithBinary(BINARY, MODEL_PATH)
      .catch((error: Error) => error);
    const secret = spawned[0].args.at(-1)!.slice("/pt-".length);

    expect(failure).toBeInstanceOf(Error);
    expect(failure.message).toMatch(/died during startup/);
    expect(failure.message).toContain("[REDACTED]");
    expect(failure.message).not.toContain(secret);
    expect(manager.requestPathPrefix).toBeNull();
  });

  it("refuses to build a command line without a prefix", () => {
    const manager: any = new WhisperServerManager();
    expect(() => manager.buildServerArgs(MODEL_PATH)).toThrow(/request path/);
  });
});
