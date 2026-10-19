import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { afterEach, describe, expect, it } from "vitest";

/**
 * The release job signs the key listener, so it must be built from this
 * checkout's source. The script used to fall back to downloading the latest
 * prebuilt listener, unpinned and unchecked. These tests run the real script
 * with the compiler replaced; any download would need a module it is not given.
 */

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function runScript({ compiles, env }: { compiles: boolean; env: Record<string, string> }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-build-key-listener-"));
  tempDirs.push(dir);
  fs.mkdirSync(path.join(dir, "resources"));
  fs.writeFileSync(path.join(dir, "resources", "windows-key-listener.c"), "int main(void) {}");

  const compileCalls: string[] = [];
  const fakeProcess: { platform: string; env: Record<string, string>; exitCode?: number } = {
    platform: "win32",
    env,
  };
  vm.runInNewContext(
    fs.readFileSync(path.resolve("scripts", "build-windows-key-listener.js"), "utf8") + "\nmain();",
    {
      module: {},
      __dirname: path.join(dir, "scripts"),
      process: fakeProcess,
      console: { log() {}, warn() {}, error() {} },
      require: (name: string) => {
        if (name === "fs") return fs;
        if (name === "path") return path;
        if (name === "./lib/compile-key-listener") {
          return {
            compileKeyListener: ({ output }: { output: string }) => {
              compileCalls.push(output);
              if (compiles) fs.writeFileSync(output, "listener");
              return { compiler: compiles ? "MSVC" : null, failures: [] };
            },
          };
        }
        throw new Error(`Unexpected module ${name}`);
      },
    }
  );

  return {
    exitCode: fakeProcess.exitCode,
    compileCalls,
    binary: path.join(dir, "resources", "bin", "windows-key-listener.exe"),
  };
}

describe("build-windows-key-listener.js", () => {
  it("builds the listener from the checkout's source", () => {
    const run = runScript({ compiles: true, env: {} });

    expect(run.compileCalls).toEqual([run.binary]);
    expect(fs.readFileSync(run.binary, "utf8")).toBe("listener");
    expect(run.exitCode).toBeUndefined();
  });

  it("fails in CI when it cannot compile, instead of downloading a prebuilt one", () => {
    const run = runScript({ compiles: false, env: { CI: "true" } });

    expect(run.exitCode).toBe(1);
    expect(fs.existsSync(run.binary)).toBe(false);
  });

  it("only warns on a developer PC without a compiler", () => {
    const run = runScript({ compiles: false, env: {} });

    expect(run.exitCode).toBeUndefined();
  });
});
