import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: {
    getPath: () => tmpdir(),
    isReady: () => false,
  },
}));

const WhisperServerManager = require("../../../src/helpers/whisperServer");

/**
 * Smart App Control blocks unsigned executables, but the block never reaches
 * Node as text — the spawn fails with `spawn UNKNOWN` (errno -4094) and nothing
 * else. That was previously classified as a transient failure, so the app
 * retried an OS block forever and told the user a graphics driver update was
 * probably to blame.
 */
describe("WhisperServerManager Windows policy-block detection", () => {
  let tempDir: string | null = null;
  let binaryPath = "";
  let manager: any;
  const realPlatform = process.platform;

  const setPlatform = (value: string) => {
    Object.defineProperty(process, "platform", { value, configurable: true });
  };

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), "pt-policy-block-"));
    binaryPath = path.join(tempDir, "whisper-server-win32-x64-cuda.exe");
    writeFileSync(binaryPath, "not a real binary");
    manager = new WhisperServerManager();
    setPlatform("win32");
  });

  afterEach(() => {
    setPlatform(realPlatform);
    vi.restoreAllMocks();
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  const spawnError = (code: string) => {
    const error: any = new Error(`spawn ${code}`);
    error.code = code;
    error.syscall = "spawn";
    return error;
  };

  it("treats a spawn refusal on an existing binary as an OS block", () => {
    for (const code of ["UNKNOWN", "EACCES", "EPERM"]) {
      expect(manager.isBlockedByWindowsPolicyFailure(spawnError(code), binaryPath)).toBe(true);
    }
  });

  it("does not claim an OS block when the binary is missing", () => {
    const missing = path.join(tempDir!, "gone.exe");
    expect(manager.isBlockedByWindowsPolicyFailure(spawnError("ENOENT"), missing)).toBe(false);
    expect(manager.isBlockedByWindowsPolicyFailure(spawnError("UNKNOWN"), missing)).toBe(false);
  });

  it("does not claim an OS block for a process that started and then exited", () => {
    const error: any = new Error("process died during startup");
    error.code = "UNKNOWN";
    error.exitCode = 3221225781; // STATUS_DLL_NOT_FOUND
    expect(manager.isBlockedByWindowsPolicyFailure(error, binaryPath)).toBe(false);
  });

  it("never claims an OS block off Windows", () => {
    setPlatform("linux");
    expect(manager.isBlockedByWindowsPolicyFailure(spawnError("EACCES"), binaryPath)).toBe(false);
  });

  it("still counts the block as recoverable so CPU fallback runs instead of throwing", () => {
    expect(manager.isRecoverableCudaStartupFailure(spawnError("UNKNOWN"))).toBe(true);
  });

  it("stops scheduling retries once blocked, and resumes after the engine is reinstalled", async () => {
    manager.cudaDisabledForSession = true;
    manager._cudaDisabledAt = Date.now();
    manager._cudaFailureCount = 1;

    manager._cudaBlockedByPolicy = false;
    expect(manager.getNextCudaRetryAt()).not.toBeNull();

    // An OS block never clears on its own; retrying only re-triggers it.
    manager._cudaBlockedByPolicy = true;
    expect(manager.getNextCudaRetryAt()).toBeNull();
    expect(manager.isCudaRetryDue()).toBe(false);

    // Installing or updating the engine clears the block and allows a retry.
    await manager.invalidateServerCache();
    expect(manager._cudaBlockedByPolicy).toBe(false);
  });

  it("clears the block when the user re-enables GPU mode", async () => {
    manager.forceCpu = true;
    manager.cudaDisabledForSession = true;
    manager._cudaBlockedByPolicy = true;

    await manager.setForceCpu(false);

    expect(manager._cudaBlockedByPolicy).toBe(false);
    expect(manager.cudaDisabledForSession).toBe(false);
  });
});
