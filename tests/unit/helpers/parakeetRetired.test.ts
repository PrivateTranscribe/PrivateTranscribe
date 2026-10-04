import os from "node:os";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * sherpa-onnx's WebSocket server listens on every network interface with no
 * password, and it has no option to stay on this machine. Until the Parakeet
 * engine is removed, starting it has to fail before anything is spawned.
 *
 * The spawn seam throws in every test here, so even a regression could never
 * launch the real binary that ships in resources/bin.
 */

const ParakeetWsServer = require("../../../src/helpers/parakeetWsServer");
const ParakeetServerManager = require("../../../src/helpers/parakeetServer");
const debugLogger = require("../../../src/helpers/debugLogger");

const RETIRED = "Parakeet was retired; use Whisper.";
const MODEL = "parakeet-tdt-0.6b-v3";

function guardSpawn(server: any) {
  return vi.spyOn(server, "_spawnServer").mockImplementation(() => {
    throw new Error("test tried to spawn the Parakeet server");
  });
}

beforeEach(() => {
  vi.spyOn(debugLogger, "write").mockImplementation(() => {});
});

describe("Parakeet WebSocket server", () => {
  it("refuses to start before it looks for the binary or spawns anything", async () => {
    const server: any = new ParakeetWsServer();
    const spawnServer = guardSpawn(server);
    const findBinary = vi.spyOn(server, "getWsBinaryPath").mockReturnValue("sherpa-onnx-ws");

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(server.start(MODEL, os.tmpdir())).rejects.toMatchObject({
        code: "PARAKEET_RETIRED",
        message: RETIRED,
      });
    }

    expect(spawnServer).not.toHaveBeenCalled();
    expect(findBinary).not.toHaveBeenCalled();
    expect(server.process).toBeNull();
    expect(server.port).toBeNull();
    expect(server.ready).toBe(false);
    expect(server.startupPromise).toBeNull();
  });

  it("reaches the start-server caller as a plain failure, not a crash", async () => {
    const manager: any = new ParakeetServerManager();
    const spawnServer = guardSpawn(manager.wsServer);
    vi.spyOn(manager.wsServer, "isAvailable").mockReturnValue(true);
    vi.spyOn(manager, "getModelsDir").mockReturnValue(os.tmpdir());
    vi.spyOn(manager, "isModelDownloaded").mockReturnValue(true);

    await expect(manager.startServer(MODEL)).resolves.toEqual({
      success: false,
      reason: RETIRED,
    });
    expect(spawnServer).not.toHaveBeenCalled();
  });

  it("fails a Parakeet transcription with the same message", async () => {
    const manager: any = new ParakeetServerManager();
    const spawnServer = guardSpawn(manager.wsServer);
    vi.spyOn(manager, "getModelsDir").mockReturnValue(os.tmpdir());
    vi.spyOn(manager, "isModelDownloaded").mockReturnValue(true);
    // Already WAV, so no FFmpeg conversion runs first.
    const wav = Buffer.concat([
      Buffer.from("RIFF"),
      Buffer.alloc(4),
      Buffer.from("WAVE"),
      Buffer.alloc(32),
    ]);

    await expect(manager.transcribe(wav, { modelName: MODEL })).rejects.toThrow(RETIRED);
    expect(spawnServer).not.toHaveBeenCalled();
  });
});
