import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  shell: { openPath: vi.fn(), openExternal: vi.fn() },
}));

describe("action engine app path hardening", () => {
  it("rejects URL and relative app action paths", async () => {
    const { validateLocalAppPath } = await import("../../../src/helpers/actionEngineManager.js");

    expect(() => validateLocalAppPath("https://example.com/app.exe")).toThrow(
      "local filesystem path"
    );
    expect(() => validateLocalAppPath("relative/app.exe")).toThrow(
      "absolute local filesystem path"
    );
  });

  it("rejects Windows network app action paths on Windows", async () => {
    const { validateLocalAppPath } = await import("../../../src/helpers/actionEngineManager.js");

    if (process.platform !== "win32") {
      expect(validateLocalAppPath("/Applications/PrivateTranscribe.app")).toBe(
        "/Applications/PrivateTranscribe.app"
      );
      return;
    }

    expect(() => validateLocalAppPath("\\\\attacker.example\\share\\app.exe")).toThrow(
      "Network paths"
    );
  });
});
