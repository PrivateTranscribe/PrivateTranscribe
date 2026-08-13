import { describe, expect, it, vi, afterEach } from "vitest";
import http from "http";
import WhisperServerManager from "../../../src/helpers/whisperServer";
import {
  normalizeWhisperLanguage,
  hasUsableSpeech,
  resolveLockableLanguage,
} from "../../../src/helpers/whisperLanguage";

afterEach(() => {
  vi.restoreAllMocks();
});

const buildManager = (chunks: Array<{ durationSeconds: number }>) => {
  const manager: any = new WhisperServerManager();
  manager.ready = true;
  manager.process = {};
  manager.canConvert = true;
  manager._scheduleIdleCheck = vi.fn();
  manager._convertToWav = vi.fn().mockResolvedValue(Buffer.from("wav"));
  manager._splitWavIntoTranscriptionChunks = vi.fn().mockReturnValue(
    chunks.map((chunk, index) => ({
      buffer: Buffer.from(`chunk-${index}`),
      durationSeconds: chunk.durationSeconds,
      offsetSeconds: index * chunk.durationSeconds,
    }))
  );
  return manager;
};

describe("whisper language normalisation", () => {
  it("maps the full names whisper.cpp emits onto request codes", () => {
    expect(normalizeWhisperLanguage("danish")).toBe("da");
    expect(normalizeWhisperLanguage("Norwegian")).toBe("no");
    expect(normalizeWhisperLanguage(" SWEDISH ")).toBe("sv");
  });

  it("passes through codes, since builds have returned both shapes", () => {
    expect(normalizeWhisperLanguage("da")).toBe("da");
    expect(normalizeWhisperLanguage("en")).toBe("en");
  });

  it("refuses to lock on anything it cannot map", () => {
    expect(normalizeWhisperLanguage("auto")).toBeNull();
    expect(normalizeWhisperLanguage("")).toBeNull();
    expect(normalizeWhisperLanguage("klingon")).toBeNull();
    expect(normalizeWhisperLanguage(undefined)).toBeNull();
    expect(normalizeWhisperLanguage(null)).toBeNull();
  });

  it("does not treat silence as evidence of a language", () => {
    expect(hasUsableSpeech({ text: "" })).toBe(false);
    expect(hasUsableSpeech({ text: "   " })).toBe(false);
    expect(hasUsableSpeech({ text: "[BLANK_AUDIO]" })).toBe(false);
    expect(hasUsableSpeech({ text: "[ blank_audio ]" })).toBe(false);
    expect(hasUsableSpeech({ text: "goddag" })).toBe(true);
  });

  it("requires both speech and a known language before locking", () => {
    expect(resolveLockableLanguage({ text: "goddag", language: "danish" })).toBe("da");
    expect(resolveLockableLanguage({ text: "[BLANK_AUDIO]", language: "danish" })).toBeNull();
    expect(resolveLockableLanguage({ text: "goddag", language: "klingon" })).toBeNull();
    expect(resolveLockableLanguage({ text: "goddag" })).toBeNull();
  });
});

describe("Whisper chunk language locking", () => {
  it("detects on the first chunk and pins that language for the rest", async () => {
    const manager = buildManager([
      { durationSeconds: 60 },
      { durationSeconds: 60 },
      { durationSeconds: 60 },
    ]);
    manager._postInference = vi
      .fn()
      .mockResolvedValueOnce({ text: "godmorgen alle sammen", language: "danish" })
      // Left to its own devices whisper drifts to a neighbouring language on
      // later chunks. Once pinned, that reply must not change the decision.
      .mockResolvedValueOnce({ text: "og saa videre", language: "norwegian" })
      .mockResolvedValueOnce({ text: "tak for i dag", language: "swedish" });

    const result = await manager.transcribe(Buffer.from("audio"), {});

    expect(manager._postInference).toHaveBeenCalledTimes(3);

    // First chunk asks the question.
    expect(manager._postInference.mock.calls[0][1]).toMatchObject({
      language: null,
      detectLanguage: true,
    });

    // Every later chunk is told the answer instead of re-rolling it.
    expect(manager._postInference.mock.calls[1][1]).toMatchObject({
      language: "da",
      detectLanguage: false,
    });
    expect(manager._postInference.mock.calls[2][1]).toMatchObject({
      language: "da",
      detectLanguage: false,
    });

    expect(result).toMatchObject({ detectedLanguage: "da" });
  });

  it("defers the decision past chunks that hold no speech", async () => {
    const manager = buildManager([
      { durationSeconds: 60 },
      { durationSeconds: 60 },
      { durationSeconds: 60 },
    ]);
    manager._postInference = vi
      .fn()
      // A recording that opens with silence or keyboard noise must not get to
      // pick the language for the following nine minutes.
      .mockResolvedValueOnce({ text: "[BLANK_AUDIO]", language: "english" })
      .mockResolvedValueOnce({ text: "saa er vi i gang", language: "danish" })
      .mockResolvedValueOnce({ text: "tak for i dag", language: "norwegian" });

    const result = await manager.transcribe(Buffer.from("audio"), {});

    expect(manager._postInference.mock.calls[0][1]).toMatchObject({ detectLanguage: true });
    expect(manager._postInference.mock.calls[1][1]).toMatchObject({
      language: null,
      detectLanguage: true,
    });
    expect(manager._postInference.mock.calls[2][1]).toMatchObject({
      language: "da",
      detectLanguage: false,
    });

    expect(result).toMatchObject({ detectedLanguage: "da" });
  });

  it("never overrides an explicit language choice", async () => {
    const manager = buildManager([{ durationSeconds: 60 }, { durationSeconds: 60 }]);
    manager._postInference = vi
      .fn()
      .mockResolvedValue({ text: "hello there", language: "norwegian" });

    const result = await manager.transcribe(Buffer.from("audio"), { language: "en" });

    for (const call of manager._postInference.mock.calls) {
      expect(call[1]).toMatchObject({ language: "en", detectLanguage: false });
    }
    // The caller already knows the language it asked for; reporting it back
    // would make a stale value look like a fresh detection.
    expect(result.detectedLanguage).toBeUndefined();
  });

  it("reports the detected language for a single chunk so the caller can pin it", async () => {
    // Live long-session segments arrive as one 60s request each, so the lock
    // has to survive across calls rather than inside the chunk loop.
    const manager = buildManager([{ durationSeconds: 60 }]);
    manager._postInference = vi.fn().mockResolvedValue({ text: "goddag", language: "danish" });

    const result = await manager.transcribe(Buffer.from("audio"), {});

    expect(result).toMatchObject({ text: "goddag", detectedLanguage: "da" });
  });

  it("stays on auto when whisper reports nothing usable", async () => {
    const manager = buildManager([{ durationSeconds: 60 }, { durationSeconds: 60 }]);
    manager._postInference = vi.fn().mockResolvedValue({ text: "mmm hmm" });

    const result = await manager.transcribe(Buffer.from("audio"), {});

    for (const call of manager._postInference.mock.calls) {
      expect(call[1]).toMatchObject({ language: null, detectLanguage: true });
    }
    expect(result.detectedLanguage).toBeUndefined();
  });
});

describe("Whisper detection request format", () => {
  it("asks for verbose_json only while the language is still unknown", async () => {
    const bodies: string[] = [];
    const server = http.createServer((req, res) => {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        bodies.push(body);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ text: "goddag", language: "danish" }));
      });
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Failed to start test server");

    const manager: any = new WhisperServerManager();
    manager.port = address.port;

    try {
      await manager._postInference(Buffer.from("wav"), {
        longSessionChunk: true,
        detectLanguage: true,
        durationSeconds: 60,
      });
      await manager._postInference(Buffer.from("wav"), {
        longSessionChunk: true,
        detectLanguage: false,
        language: "da",
        durationSeconds: 60,
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    expect(bodies[0]).toMatch(/name="response_format"[\s\S]*verbose_json/);
    expect(bodies[0]).not.toMatch(/name="language"/);

    expect(bodies[1]).not.toMatch(/name="response_format"[\s\S]*verbose_json/);
    expect(bodies[1]).toMatch(/name="language"[\s\S]*da/);
  });
});
