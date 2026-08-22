import { tmpdir } from "os";
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: {
    getPath: () => tmpdir(),
    isReady: () => false,
  },
}));

const WhisperServerManager = require("../../../src/helpers/whisperServer");

/**
 * whisper-server loads every ggml-*.dll it finds beside its own executable.
 * Selecting the non-CUDA binary is therefore not enough to get a CPU run: if a
 * GPU backend happens to sit in that directory the server picks it up and the
 * user gets GPU inference while the UI says CPU. It fails silently - the only
 * symptom is a benchmark that looks suspiciously good.
 */
describe("whisper-server engine-mode flags", () => {
  const modelPath = "/models/ggml-turbo.bin";

  it("passes --no-gpu when CPU mode is forced", () => {
    const manager = new WhisperServerManager();
    manager.forceCpu = true;

    expect(manager.buildServerArgs(modelPath)).toContain("--no-gpu");
  });

  it("does not pass --no-gpu when CPU mode is not forced", () => {
    const manager = new WhisperServerManager();
    manager.forceCpu = false;

    expect(manager.buildServerArgs(modelPath)).not.toContain("--no-gpu");
  });

  it("still carries the model, host and port", () => {
    const manager = new WhisperServerManager();
    manager.forceCpu = true;
    const args = manager.buildServerArgs(modelPath);

    expect(args.slice(0, 4)).toEqual(["--model", modelPath, "--host", "127.0.0.1"]);
    expect(args[args.indexOf("--port") + 1]).toBe(String(manager.port));
  });

  it("always states a thread count rather than leaning on whisper.cpp's default", () => {
    const manager = new WhisperServerManager();
    const args = manager.buildServerArgs(modelPath);

    // The default is min(4, cores), which is what left every machine on 4.
    expect(args).toContain("--threads");
    const resolved = Number(args[args.indexOf("--threads") + 1]);
    expect(Number.isInteger(resolved)).toBe(true);
    expect(resolved).toBeGreaterThan(0);
  });

  it("lets an explicit thread count win", () => {
    const manager = new WhisperServerManager();
    const args = manager.buildServerArgs(modelPath, { threads: 12 });

    expect(args[args.indexOf("--threads") + 1]).toBe("12");
  });

  it("defaults language to auto and honours an explicit one", () => {
    const manager = new WhisperServerManager();

    const auto = manager.buildServerArgs(modelPath);
    expect(auto[auto.indexOf("--language") + 1]).toBe("auto");

    const danish = manager.buildServerArgs(modelPath, { language: "da" });
    expect(danish[danish.indexOf("--language") + 1]).toBe("da");
  });
});
