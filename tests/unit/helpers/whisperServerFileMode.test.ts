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
  });
});
