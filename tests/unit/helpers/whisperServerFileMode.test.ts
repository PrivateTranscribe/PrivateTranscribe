import { describe, expect, it, vi, afterEach } from "vitest";
import fs from "fs";
import http from "http";
import WhisperServerManager from "../../../src/helpers/whisperServer";

const originalRequest = http.request;

afterEach(() => {
  http.request = originalRequest;
  vi.restoreAllMocks();
});

describe("WhisperServer file mode", () => {
  it("contains the file-mode noise reduction filter", () => {
    const source = fs.readFileSync("src/helpers/whisperServer.js", "utf8");
    expect(source).toContain("afftdn=nf=-25");
    expect(source).toContain("noiseReduction");
    expect(source).toContain("channels: fileMode && diarize ? 2 : 1");
  });

  it("uses verbose_json, diarize, tinydiarize, and vad in file mode posts", async () => {
    let body = "";
    const server = http.createServer((req, res) => {
      req.setEncoding("utf8");
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ text: "ok", segments: [] }));
      });
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Failed to start test server");

    const manager: any = new WhisperServerManager();
    manager.port = address.port;
    manager.requestPathPrefix = "/pt-unit-test";

    try {
      await manager._postInference(Buffer.from("wav"), {
        fileMode: true,
        diarize: true,
        tinydiarize: true,
        vad: true,
        durationSeconds: 1,
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    expect(body).toContain('name="response_format"');
    expect(body).toContain("verbose_json");
    expect(body).toContain('name="diarize"');
    expect(body).toContain('name="tinydiarize"');
    expect(body).toContain('name="vad"');
    expect(body).toContain('name="no_context"');
    expect(body).toContain('name="suppress_nst"');
    expect(body).toContain('name="temperature"');
    expect(body).toContain('name="temperature_inc"');
    expect(body).toMatch(/name="temperature_inc"[\s\S]*0\.2/);
    expect(body).toContain('name="no_speech_thold"');
    expect(body).toContain('name="token_timestamps"');
    // Token timestamps trigger server-side cue wrapping. It must wrap on words,
    // otherwise the formatter turns a split Danish word into two separate words.
    expect(body).toMatch(/name="split_on_word"\r\n\r\ntrue/);
  });

  it("uses conservative decoding controls for live long-session chunks", async () => {
    let body = "";
    const server = http.createServer((req, res) => {
      req.setEncoding("utf8");
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ text: "ok" }));
      });
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Failed to start test server");

    const manager: any = new WhisperServerManager();
    manager.port = address.port;
    manager.requestPathPrefix = "/pt-unit-test";

    try {
      await manager._postInference(Buffer.from("wav"), {
        longSessionChunk: true,
        durationSeconds: 60,
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    expect(body).toContain('name="response_format"');
    expect(body).toContain("json");
    expect(body).toContain('name="no_context"');
    expect(body).toContain('name="suppress_nst"');
    expect(body).toContain('name="temperature_inc"');
    expect(body).toContain('name="no_speech_thold"');
  });

  it("retries file-mode verbose_json failures without restarting the server", async () => {
    const manager: any = new WhisperServerManager();
    manager.ready = true;
    manager.process = {};
    manager.canConvert = true;
    manager._scheduleIdleCheck = vi.fn();
    manager._convertToWav = vi.fn().mockResolvedValue(Buffer.from("wav"));
    manager._splitWavIntoTranscriptionChunks = vi.fn().mockReturnValue([
      {
        buffer: Buffer.from("chunk"),
        durationSeconds: 12,
        offsetSeconds: 0,
      },
    ]);
    manager._postInference = vi
      .fn()
      .mockRejectedValueOnce(new Error("verbose_json failed"))
      .mockResolvedValueOnce({ text: "fallback transcript" });
    manager.stop = vi.fn();
    manager.start = vi.fn();

    const result = await manager.transcribe(Buffer.from("audio"), {
      fileMode: true,
      language: "en",
      initialPrompt: "terms",
    });

    expect(manager._postInference).toHaveBeenCalledTimes(2);
    expect(manager._postInference.mock.calls[0][1]).toMatchObject({
      fileMode: true,
      language: "en",
      initialPrompt: "terms",
    });
    expect(manager._postInference.mock.calls[1][1]).toMatchObject({
      fileMode: false,
      language: "en",
      initialPrompt: "terms",
    });
    expect(manager.stop).not.toHaveBeenCalled();
    expect(manager.start).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      text: "fallback transcript",
      verboseJsonFallback: true,
      segments: [{ start: 0, end: 12, text: "fallback transcript" }],
    });
  });

  it("offsets nested word times together with each chunk's segments", async () => {
    const manager: any = new WhisperServerManager();
    manager.ready = true;
    manager.process = {};
    manager.canConvert = true;
    manager._scheduleIdleCheck = vi.fn();
    manager._convertToWav = vi.fn().mockResolvedValue(Buffer.from("wav"));
    manager._splitWavIntoTranscriptionChunks = vi.fn().mockReturnValue([
      { buffer: Buffer.from("a"), durationSeconds: 60, offsetSeconds: 0 },
      { buffer: Buffer.from("b"), durationSeconds: 10, offsetSeconds: 60 },
    ]);
    const segment = {
      start: 1,
      end: 3,
      text: " Ja.",
      words: [
        { word: " Ja", start: 1, end: 2 },
        { word: ".", start: -0.01, end: -0.01 },
      ],
    };
    manager._postInference = vi.fn().mockResolvedValue({ text: "Ja.", segments: [segment] });
    const result = await manager.transcribe(Buffer.from("audio"), {
      fileMode: true,
      language: "da",
    });
    expect(result.segments[1]).toMatchObject({
      start: 61,
      end: 63,
      words: [
        { word: " Ja", start: 61, end: 62 },
        { word: ".", start: -0.01, end: -0.01 },
      ],
    });
    expect(segment.words[0].start).toBe(1);
  });
});
