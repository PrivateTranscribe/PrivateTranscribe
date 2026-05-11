import { EventEmitter } from "events";
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
    const manager: any = new WhisperServerManager();
    manager.port = 8178;
    const written: Buffer[] = [];

    http.request = ((options: any, callback: any) => {
      const req: any = new EventEmitter();
      req.write = (chunk: Buffer) => written.push(Buffer.from(chunk));
      req.end = () => {
        const res: any = new EventEmitter();
        res.statusCode = 200;
        callback(res);
        res.emit("data", JSON.stringify({ text: "ok", segments: [] }));
        res.emit("end");
      };
      req.destroy = vi.fn();
      return req;
    }) as any;

    await manager._postInference(Buffer.from("wav"), {
      fileMode: true,
      diarize: true,
      tinydiarize: true,
      vad: true,
      durationSeconds: 1,
    });

    const body = Buffer.concat(written).toString("utf8");
    expect(body).toContain('name="response_format"');
    expect(body).toContain("verbose_json");
    expect(body).toContain('name="diarize"');
    expect(body).toContain('name="tinydiarize"');
    expect(body).toContain('name="vad"');
  });
});
