import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: {
    getPath: () => "/tmp",
    isReady: () => false,
  },
}));

const ParakeetManager = require("../../../src/helpers/parakeet");

describe("ParakeetManager startup initialization", () => {
  it("does not pre-warm parakeet server on startup", async () => {
    const manager = new ParakeetManager();
    manager.logDependencyStatus = vi.fn(async () => {});
    manager.serverManager = {
      setServerIdleTimeoutMinutes: vi.fn(),
      startServer: vi.fn(async () => {}),
      isAvailable: vi.fn(() => true),
      isModelDownloaded: vi.fn(() => true),
      getBinaryPath: vi.fn(() => null),
      getServerStatus: vi.fn(() => ({})),
    };

    await manager.initializeAtStartup({
      localTranscriptionProvider: "nvidia",
      parakeetModel: "parakeet-tdt-0.6b-v3",
      parakeetServerIdleTimeoutMinutes: 2,
    });

    expect(manager.serverManager.setServerIdleTimeoutMinutes).toHaveBeenCalledWith(2);
    expect(manager.serverManager.startServer).not.toHaveBeenCalled();
  });
});
