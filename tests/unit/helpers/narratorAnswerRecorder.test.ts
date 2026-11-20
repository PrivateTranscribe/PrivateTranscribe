import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The real AudioManager pulls in the whole dictation pipeline; every test
// hands the recorder its own manager.
vi.mock("../../../src/helpers/audioManager", () => ({ default: class {} }));

import logger from "../../../src/utils/logger";
import { NarratorAnswerRecorder } from "../../../src/helpers/narratorAnswerRecorder";

class FakeMediaRecorder {
  state = "inactive";
  mimeType = "audio/webm";
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  start() {
    this.state = "recording";
  }
  stop() {
    this.state = "inactive";
    this.ondataavailable?.({ data: new Blob(["sound"]) });
    this.onstop?.();
  }
}

function fakeStream() {
  const track = { label: "Headset mic", getSettings: () => ({ sampleRate: 48000 }), stop() {} };
  return { getAudioTracks: () => [track], getTracks: () => [track] };
}

function setup({ localOnly = true, openMic = async () => fakeStream() } = {}) {
  const manager = {
    prewarmTranscription: vi.fn(),
    getAudioConstraints: vi.fn(async () => ({ audio: true })),
    runTranscription: vi.fn(async () => ({ result: { text: "one" } })),
  };
  const api = { narratorAnswerHeard: vi.fn() };
  const recorder = new NarratorAnswerRecorder({
    isLocalOnly: () => localOnly,
    api,
    createManager: () => manager,
    mediaDevices: { getUserMedia: vi.fn(openMic) },
  });
  return { recorder, manager, api };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function loggedWith(message: string) {
  const call = vi.mocked(logger.info).mock.calls.find(([text]) => text === message);
  return call?.[1];
}

describe("NarratorAnswerRecorder", () => {
  beforeEach(() => {
    (globalThis as any).MediaRecorder = FakeMediaRecorder;
    vi.spyOn(logger, "info").mockImplementation(() => {});
  });

  afterEach(() => {
    delete (globalThis as any).MediaRecorder;
    vi.restoreAllMocks();
  });

  it("starts the local engine while a question is asked, so the answer meets no model load", () => {
    const { recorder, manager } = setup();
    recorder.prepare();
    expect(manager.prewarmTranscription).toHaveBeenCalledTimes(1);
  });

  it("starts nothing when transcription could leave the PC", () => {
    const { recorder, manager } = setup({ localOnly: false });
    recorder.prepare();
    expect(manager.prewarmTranscription).not.toHaveBeenCalled();
  });

  it("starts the engine with the recording too, and logs the microphone and the take", async () => {
    const { recorder, manager, api } = setup();
    recorder.handle({ type: "start", id: "a1", language: "en" });
    await flush();
    expect(manager.prewarmTranscription).toHaveBeenCalled();
    expect(loggedWith("Voice answer recording started")).toMatchObject({
      label: "Headset mic",
      sampleRate: 48000,
      keyAlreadyUp: false,
    });

    recorder.handle({ type: "stop", id: "a1" });
    await flush();
    expect(loggedWith("Voice answer recording stopped")).toMatchObject({
      blobSize: 5,
      chunksCount: 1,
    });
    expect(manager.runTranscription).toHaveBeenCalledTimes(1);
    expect(api.narratorAnswerHeard).toHaveBeenCalledWith({ id: "a1", text: "one" });
  });

  it("logs a key that came up while the microphone opened", async () => {
    let open: (stream: ReturnType<typeof fakeStream>) => void = () => {};
    const { recorder } = setup({
      openMic: () => new Promise((resolve) => (open = resolve)),
    });
    recorder.handle({ type: "start", id: "a2", language: "en" });
    await flush();
    recorder.handle({ type: "stop", id: "a2" });
    open(fakeStream());
    await flush();
    await flush();

    expect(loggedWith("Voice answer recording started")).toMatchObject({ keyAlreadyUp: true });
    const stopped = loggedWith("Voice answer recording stopped");
    expect(stopped.recordedSeconds).toBeLessThan(0.05);
  });
});
