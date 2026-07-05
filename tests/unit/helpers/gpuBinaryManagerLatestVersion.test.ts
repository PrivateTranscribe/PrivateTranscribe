import { tmpdir } from "os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: {
    getPath: () => tmpdir(),
    isReady: () => false,
  },
}));

const GpuBinaryManager = require("../../../src/helpers/gpuBinaryManager");

const jsonResponse = (body: unknown, ok = true) =>
  ({
    ok,
    json: async () => body,
  }) as Response;

describe("GpuBinaryManager.fetchLatestAvailableVersion", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the version advertised by the manifest", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ version: "v0.0.9" }));

    const manager = new GpuBinaryManager();
    await expect(manager.fetchLatestAvailableVersion()).resolves.toBe("v0.0.9");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://updates.privatetranscribe.com/binaries/latest-cuda.json",
      expect.objectContaining({ cache: "no-store" })
    );
  });

  it("caches successful lookups instead of refetching", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ version: "v0.0.9" }));

    const manager = new GpuBinaryManager();
    await manager.fetchLatestAvailableVersion();
    await manager.fetchLatestAvailableVersion();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns null when the manifest is missing (404)", async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, false));

    const manager = new GpuBinaryManager();
    await expect(manager.fetchLatestAvailableVersion()).resolves.toBeNull();
  });

  it("returns null when the network is down", async () => {
    fetchMock.mockRejectedValue(new Error("offline"));

    const manager = new GpuBinaryManager();
    await expect(manager.fetchLatestAvailableVersion()).resolves.toBeNull();
  });

  it("rejects manifests with malformed version strings", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ version: "not-a-version" }));

    const manager = new GpuBinaryManager();
    await expect(manager.fetchLatestAvailableVersion()).resolves.toBeNull();
  });

  it("never affects the pinned install version", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ version: "v99.0.0" }));

    const manager = new GpuBinaryManager();
    await manager.fetchLatestAvailableVersion();
    // Installs stay pinned to the app build's BINARY_VERSION.
    expect(manager.getExpectedCudaBinaryVersion()).toMatch(/^v\d+\.\d+\.\d+$/);
    expect(manager.getExpectedCudaBinaryVersion()).not.toBe("v99.0.0");
  });
});
