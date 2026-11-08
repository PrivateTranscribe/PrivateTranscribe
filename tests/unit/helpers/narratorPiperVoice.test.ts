import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { PiperVoice } = require("../../../src/helpers/narrator/voices");

type Message = { id: number; op: string; args: Record<string, unknown> };
type Reply = { ok: boolean; result?: unknown; error?: { message: string; code: string } } | null;

/** Stands in for piperHost.js: answers each message with `reply`, or never when it returns null. */
function fakeHost(reply: (message: Message) => Reply) {
  const host = new EventEmitter() as EventEmitter & {
    sent: Message[];
    postMessage: (message: Message) => void;
    kill: ReturnType<typeof vi.fn>;
  };
  host.sent = [];
  host.postMessage = (message) => {
    host.sent.push(message);
    queueMicrotask(() => {
      const answer = reply(message);
      if (answer) host.emit("message", { id: message.id, ...answer });
    });
  };
  host.kill = vi.fn(() => queueMicrotask(() => host.emit("exit", null)));
  return host;
}

const speaks = (message: Message): Reply =>
  message.op === "load"
    ? { ok: true, result: { loadMs: 5 } }
    : { ok: true, result: { samples: new Float32Array([0.1, -0.1]), sampleRate: 22050 } };

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-piper-voice-"));
  fs.writeFileSync(path.join(dir, "model.onnx"), "");
  fs.writeFileSync(path.join(dir, "tokens.txt"), "");
  fs.mkdirSync(path.join(dir, "espeak-ng-data"));
  fs.writeFileSync(path.join(dir, "espeak-ng-data", "phontab"), "");
  vi.stubEnv("PT_NARRATOR_PIPER_DIR", dir);
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("the Danish Piper voice", () => {
  it("loads the engine once in its host process and speaks through it", async () => {
    const hosts: ReturnType<typeof fakeHost>[] = [];
    const voice = new PiperVoice({ createHost: () => hosts[hosts.push(fakeHost(speaks)) - 1] });

    const first = await voice.synthesize("Hej.");
    await voice.synthesize("Igen.");

    expect(hosts).toHaveLength(1);
    expect(hosts[0].sent.map((m) => m.op)).toEqual(["load", "speak", "speak"]);
    expect(hosts[0].sent[0].args).toMatchObject({
      model: path.join(dir, "model.onnx"),
      tokens: path.join(dir, "tokens.txt"),
      dataDir: path.join(dir, "espeak-ng-data"),
    });
    expect(hosts[0].sent[1].args).toEqual({ text: "Hej." });
    expect(first.sampleRate).toBe(22050);
    expect(Array.from(first.pcm)).toEqual([expect.closeTo(0.1), expect.closeTo(-0.1)]);
  });

  it("fails the waiting sentence when the host dies, and starts a new host for the next", async () => {
    const hosts: ReturnType<typeof fakeHost>[] = [];
    let hang = true;
    const voice = new PiperVoice({
      createHost: () =>
        hosts[hosts.push(fakeHost((m) => (m.op === "speak" && hang ? null : speaks(m)))) - 1],
    });

    const waiting = voice.synthesize("Hej.");
    await vi.waitFor(() => expect(hosts[0]?.sent.map((m) => m.op)).toEqual(["load", "speak"]));
    hosts[0].emit("exit", 3221225477);
    await expect(waiting).rejects.toThrow("The Danish voice stopped (3221225477)");

    hang = false;
    await expect(voice.synthesize("Igen.")).resolves.toMatchObject({ sampleRate: 22050 });
    expect(hosts).toHaveLength(2);
    expect(hosts[1].sent.map((m) => m.op)).toEqual(["load", "speak"]);
  });

  it("passes the host's error on with its code", async () => {
    const voice = new PiperVoice({
      createHost: () =>
        fakeHost((m) =>
          m.op === "load" ? { ok: false, error: { message: "bad model", code: "x" } } : speaks(m)
        ),
    });
    await expect(voice.synthesize("Hej.")).rejects.toMatchObject({
      message: "bad model",
      code: "x",
    });
  });

  it("stops the host before it deletes the voice files", async () => {
    const host = fakeHost(speaks);
    const voice = new PiperVoice({ createHost: () => host });
    await voice.synthesize("Hej.");

    await voice.remove();

    expect(host.kill).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(dir)).toBe(false);
  });

  it("says the voice is missing without starting a host", async () => {
    fs.rmSync(path.join(dir, "model.onnx"));
    const createHost = vi.fn(() => fakeHost(speaks));
    const voice = new PiperVoice({ createHost });
    await expect(voice.synthesize("Hej.")).rejects.toMatchObject({ code: "voice-missing" });
    expect(createHost).not.toHaveBeenCalled();
  });
});
