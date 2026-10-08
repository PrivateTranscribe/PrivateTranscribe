import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ParakeetClient = require("../../../src/helpers/parakeetClient");
const debugLogger = require("../../../src/helpers/debugLogger");

const MODEL = "parakeet-tdt-0.6b-v3";
const HOUR_MS = 60 * 60 * 1000;

type Message = { id: number; op: string; args: any };
type Reply = { ok: true; result: any } | { ok: false; error: { message: string; code?: string } };

/** Stands in for the utility process: records each message and answers through `respond`. */
class FakeHost extends EventEmitter {
  pid = 4242;
  killed = false;
  messages: Message[] = [];
  constructor(private respond: (message: Message) => Reply | null) {
    super();
  }
  postMessage(message: Message) {
    this.messages.push(message);
    const reply = this.respond(message);
    // Microtask, not setImmediate, so fake timers never hold a reply back.
    if (reply) queueMicrotask(() => this.emit("message", { id: message.id, ...reply }));
  }
  kill() {
    this.killed = true;
    return true;
  }
  ops() {
    return this.messages.map((message) => message.op);
  }
}

const loadReply = (message: Message): Reply => ({
  ok: true,
  result: { numThreads: message.args.numThreads, loadMs: 5 },
});

let modelDir: string;

beforeEach(() => {
  vi.spyOn(debugLogger, "write").mockImplementation(() => {});
  modelDir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-parakeet-client-"));
  for (const file of ParakeetClient.REQUIRED_MODEL_FILES) {
    fs.writeFileSync(path.join(modelDir, file), "");
  }
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  fs.rmSync(modelDir, { recursive: true, force: true });
});

function makeClient(respond: (message: Message) => Reply | null) {
  const client: any = new ParakeetClient({ getModelDir: () => modelDir });
  const hosts: FakeHost[] = [];
  const spawn = vi.spyOn(client, "_spawnHost").mockImplementation(() => {
    const host = new FakeHost(respond);
    hosts.push(host);
    return host;
  });
  return { client, hosts, spawn };
}

function prepared(chunks: Float32Array[], speechFound = chunks.length > 0) {
  return { chunks, sampleRate: 16000, speechFound, durationSec: chunks.length * 2 };
}

describe("ParakeetClient.transcribe", () => {
  it("decodes every chunk in order and joins the texts with one space", async () => {
    const chunks = [new Float32Array([0.1]), new Float32Array([0.2]), new Float32Array([0.3])];
    const texts = new Map([
      [chunks[0], " Hello there."],
      [chunks[1], "  "],
      [chunks[2], "General Kenobi. "],
    ]);
    const { client, hosts } = makeClient((message) =>
      message.op === "load"
        ? loadReply(message)
        : { ok: true, result: { text: texts.get(message.args.samples) } }
    );
    vi.spyOn(client, "_prepareAudio").mockResolvedValue(prepared(chunks));

    const result = await client.transcribe(Buffer.from("audio"), { model: MODEL });

    expect(result).toMatchObject({ success: true, text: "Hello there. General Kenobi." });
    expect(hosts).toHaveLength(1);
    expect(hosts[0].ops()).toEqual(["load", "decode", "decode", "decode"]);
    expect(hosts[0].messages[0].args).toMatchObject({ modelDir });
    expect(hosts[0].messages[0].args.numThreads).toBeGreaterThanOrEqual(1);
    expect(hosts[0].messages[0].args.numThreads).toBeLessThanOrEqual(4);
  });

  it("returns noSpeech without decoding when preparation found nothing to decode", async () => {
    const { client, hosts } = makeClient((message) =>
      message.op === "load" ? loadReply(message) : { ok: true, result: { text: "invented" } }
    );
    vi.spyOn(client, "_prepareAudio").mockResolvedValue(prepared([], false));

    const result = await client.transcribe(Buffer.from("audio"), { model: MODEL });

    expect(result).toMatchObject({ success: true, text: "", noSpeech: true });
    expect(hosts.flatMap((host) => host.ops())).not.toContain("decode");
  });

  it("still decodes a quiet utterance the speech detector missed", async () => {
    const { client } = makeClient((message) =>
      message.op === "load" ? loadReply(message) : { ok: true, result: { text: "quiet words" } }
    );
    vi.spyOn(client, "_prepareAudio").mockResolvedValue(
      prepared([new Float32Array([0.01])], false)
    );

    await expect(client.transcribe(Buffer.from("audio"), { model: MODEL })).resolves.toMatchObject({
      success: true,
      text: "quiet words",
    });
  });

  it("fails the request a crashed host was serving, then respawns on the next one", async () => {
    let crashNextDecode = true;
    const { client, hosts, spawn } = makeClient((message) => {
      if (message.op === "load") return loadReply(message);
      if (crashNextDecode) {
        crashNextDecode = false;
        const host = hosts[hosts.length - 1];
        queueMicrotask(() => host.emit("exit", 3221226505));
        return null;
      }
      return { ok: true, result: { text: "back again" } };
    });
    vi.spyOn(client, "_prepareAudio").mockResolvedValue(prepared([new Float32Array([0.5])]));

    await expect(client.transcribe(Buffer.from("audio"), { model: MODEL })).rejects.toMatchObject({
      code: "parakeet-host-exited",
    });
    expect(client.getStatus().running).toBe(false);

    await expect(client.transcribe(Buffer.from("audio"), { model: MODEL })).resolves.toMatchObject({
      success: true,
      text: "back again",
    });
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(hosts[1].ops()).toEqual(["load", "decode"]);
  });

  it("kills a host that does not answer within the request timeout", async () => {
    vi.useFakeTimers();
    const { client, hosts } = makeClient((message) =>
      message.op === "load" ? loadReply(message) : null
    );
    vi.spyOn(client, "_prepareAudio").mockResolvedValue(prepared([new Float32Array([0.5])]));

    const pending = client.transcribe(Buffer.from("audio"), { model: MODEL });
    const settled = expect(pending).rejects.toMatchObject({ code: "parakeet-timeout" });
    await vi.advanceTimersByTimeAsync(ParakeetClient.REQUEST_TIMEOUT_MS);
    await settled;

    expect(hosts[0].killed).toBe(true);
    expect(client.getStatus().running).toBe(false);
  });

  it("refuses a model that is not downloaded before touching the host", async () => {
    const { client, spawn } = makeClient(loadReply);
    fs.rmSync(path.join(modelDir, "tokens.txt"));

    await expect(client.transcribe(Buffer.from("audio"), { model: MODEL })).rejects.toMatchObject({
      code: "model_not_found",
    });
    expect(spawn).not.toHaveBeenCalled();
  });
});

describe("ParakeetClient idle unload", () => {
  it("unloads after 30 minutes without use, and a request postpones it", async () => {
    vi.useFakeTimers();
    const { client, hosts } = makeClient((message) =>
      message.op === "load" ? loadReply(message) : { ok: true, result: { text: "hi" } }
    );
    vi.spyOn(client, "_prepareAudio").mockResolvedValue(prepared([new Float32Array([0.5])]));

    await expect(client.start(MODEL)).resolves.toMatchObject({ success: true });
    expect(client.getStatus()).toMatchObject({ running: true, idleTimeoutMinutes: 30 });

    await vi.advanceTimersByTimeAsync(20 * 60 * 1000);
    await client.transcribe(Buffer.from("audio"), { model: MODEL });
    await vi.advanceTimersByTimeAsync(20 * 60 * 1000);
    expect(hosts[0].killed).toBe(false);

    await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 1);
    expect(hosts[0].killed).toBe(true);
    expect(client.getStatus()).toMatchObject({ running: false, stoppedDueToIdle: true });
  });

  it("never unloads when the timeout is set to zero", async () => {
    vi.useFakeTimers();
    const { client, hosts } = makeClient(loadReply);
    client.setIdleTimeoutMinutes(0);

    await client.start(MODEL);
    await vi.advanceTimersByTimeAsync(5 * HOUR_MS);

    expect(hosts[0].killed).toBe(false);
    expect(client.getStatus().running).toBe(true);
  });
});

describe("ParakeetClient.speedTest", () => {
  function timedClient(elapsedMs: number) {
    const { client, hosts } = makeClient((message) =>
      message.op === "load" ? loadReply(message) : { ok: true, result: { text: "ask not" } }
    );
    const clock = [1000, 1000 + elapsedMs];
    vi.spyOn(client, "_now").mockImplementation(() => clock.shift());
    return { client, hosts };
  }

  it("passes when the timed decode of the 10 s clip takes at most 1500 ms", async () => {
    const { client, hosts } = timedClient(1500);

    const result = await client.speedTest(MODEL);

    expect(result).toEqual({
      success: true,
      decodeMs: 1500,
      audioSec: expect.closeTo(10, 1),
      thresholdMs: 1500,
      passed: true,
    });
    // One warm-up decode, then the timed one.
    expect(hosts[0].ops()).toEqual(["load", "decode", "decode"]);
    expect(hosts[0].messages[1].args.samples).toBeInstanceOf(Float32Array);
  });

  it("fails when the timed decode is slower than 1500 ms", async () => {
    const { client } = timedClient(1501);

    await expect(client.speedTest(MODEL)).resolves.toMatchObject({
      success: true,
      decodeMs: 1501,
      passed: false,
    });
  });
});
