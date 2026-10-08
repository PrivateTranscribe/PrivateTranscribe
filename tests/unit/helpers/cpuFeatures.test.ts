import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The real probe starts PowerShell, which a unit test has no business doing, so
 * these tests spy on the spawn layer instead: `internals.runPowerShell` for the
 * parsing and caching, and child_process.execFile for the wrapper itself.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const cpuFeatures = require("../../../src/helpers/cpuFeatures");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const childProcess = require("child_process");

let platformSpy: ReturnType<typeof vi.spyOn> | null = null;

function mockPlatform(platform: NodeJS.Platform) {
  platformSpy?.mockRestore();
  platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue(platform);
}

beforeEach(() => {
  cpuFeatures.resetCpuFeaturesCache();
  mockPlatform("win32");
});

describe("detectAvx2", () => {
  it.each([
    ["True\r\n", true],
    ["False\r\n", false],
    ["  true ", true],
    ["FALSE", false],
  ])("parses %j as %s", async (stdout, expected) => {
    vi.spyOn(cpuFeatures.internals, "runPowerShell").mockResolvedValue(stdout);
    await expect(cpuFeatures.detectAvx2()).resolves.toBe(expected);
  });

  it.each([[""], ["Add-Type : blocked by policy"], ["True\r\nFalse"], [undefined]])(
    "returns null for unexpected output %j",
    async (stdout) => {
      vi.spyOn(cpuFeatures.internals, "runPowerShell").mockResolvedValue(stdout);
      await expect(cpuFeatures.detectAvx2()).resolves.toBeNull();
    }
  );

  it("returns null when the probe times out", async () => {
    const timeout = Object.assign(new Error("Command failed: powershell.exe"), {
      killed: true,
      signal: "SIGTERM",
    });
    vi.spyOn(cpuFeatures.internals, "runPowerShell").mockRejectedValue(timeout);
    await expect(cpuFeatures.detectAvx2()).resolves.toBeNull();
  });

  it("returns null when PowerShell cannot be spawned", async () => {
    const enoent = Object.assign(new Error("spawn powershell.exe ENOENT"), { code: "ENOENT" });
    vi.spyOn(cpuFeatures.internals, "runPowerShell").mockRejectedValue(enoent);
    await expect(cpuFeatures.detectAvx2()).resolves.toBeNull();
  });

  it("returns null when the spawn wrapper throws synchronously", async () => {
    vi.spyOn(cpuFeatures.internals, "runPowerShell").mockImplementation(() => {
      throw new Error("boom");
    });
    await expect(cpuFeatures.detectAvx2()).resolves.toBeNull();
  });

  it.each(["darwin", "linux"] as NodeJS.Platform[])(
    "returns null on %s without spawning anything",
    async (platform) => {
      mockPlatform(platform);
      const spy = vi.spyOn(cpuFeatures.internals, "runPowerShell");
      await expect(cpuFeatures.detectAvx2()).resolves.toBeNull();
      expect(spy).not.toHaveBeenCalled();
    }
  );

  it("caches a definite answer for the process lifetime", async () => {
    const spy = vi.spyOn(cpuFeatures.internals, "runPowerShell").mockResolvedValue("True");
    await cpuFeatures.detectAvx2();
    await cpuFeatures.detectAvx2();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("shares one probe between concurrent callers", async () => {
    const spy = vi.spyOn(cpuFeatures.internals, "runPowerShell").mockResolvedValue("False");
    const results = await Promise.all([cpuFeatures.detectAvx2(), cpuFeatures.detectAvx2()]);
    expect(results).toEqual([false, false]);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("retries after an unknown answer instead of caching it", async () => {
    const spy = vi
      .spyOn(cpuFeatures.internals, "runPowerShell")
      .mockRejectedValueOnce(new Error("timed out"))
      .mockResolvedValueOnce("True");
    await expect(cpuFeatures.detectAvx2()).resolves.toBeNull();
    await expect(cpuFeatures.detectAvx2()).resolves.toBe(true);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("asks kernel32 for PF_AVX2_INSTRUCTIONS_AVAILABLE and nothing from user32", () => {
    expect(cpuFeatures.AVX2_SCRIPT).toContain("kernel32.dll");
    expect(cpuFeatures.AVX2_SCRIPT).toContain("IsProcessorFeaturePresent(40)");
    expect(cpuFeatures.AVX2_SCRIPT).not.toMatch(/user32/i);
  });
});

describe("runPowerShell", () => {
  it("runs a hidden, profile-free PowerShell with a 5 s timeout", async () => {
    const execSpy = vi.spyOn(childProcess, "execFile").mockImplementation((...args: unknown[]) => {
      const callback = args[3] as (error: Error | null, stdout: string) => void;
      callback(null, "True\r\n");
      return {} as never;
    });

    await expect(cpuFeatures.internals.runPowerShell(cpuFeatures.AVX2_SCRIPT)).resolves.toBe(
      "True\r\n"
    );

    const [command, args, options] = execSpy.mock.calls[0] as [string, string[], object];
    expect(command).toBe("powershell.exe");
    expect(args).toEqual(
      expect.arrayContaining(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass"])
    );
    expect(args.slice(-2)).toEqual(["-Command", cpuFeatures.AVX2_SCRIPT]);
    expect(options).toMatchObject({ timeout: 5000, windowsHide: true });
  });

  it("rejects when execFile reports an error, such as a timeout kill", async () => {
    vi.spyOn(childProcess, "execFile").mockImplementation((...args: unknown[]) => {
      const callback = args[3] as (error: Error | null, stdout: string) => void;
      callback(Object.assign(new Error("killed"), { killed: true }), "");
      return {} as never;
    });

    await expect(cpuFeatures.internals.runPowerShell("x")).rejects.toThrow("killed");
  });
});
