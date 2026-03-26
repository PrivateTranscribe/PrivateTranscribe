import { afterEach, describe, expect, test, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { __test } = require("../../../src/helpers/activeWindowContext");

const { resolveOnPathForPlatform } = __test;

afterEach(() => {
  vi.restoreAllMocks();
});

function mockStatMode(filePath: string, mode: number) {
  const originalStatSync = fs.statSync;
  vi.spyOn(fs, "statSync").mockImplementation(((targetPath: fs.PathLike, options?: any) => {
    const stat = originalStatSync(targetPath, options);
    if (String(targetPath) !== filePath) {
      return stat;
    }

    return {
      ...stat,
      mode,
      isFile: () => stat.isFile(),
    };
  }) as typeof fs.statSync);
}

describe("activeWindowContext PATH resolver", () => {
  test("linux: resolves executable from PATH", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "privoca-path-"));
    const bin = path.join(dir, "hello");
    fs.writeFileSync(bin, "#!/bin/sh\necho hi\n", "utf8");
    fs.chmodSync(bin, 0o755);
    mockStatMode(bin, 0o100755);

    const resolved = resolveOnPathForPlatform("hello", {
      platform: "linux",
      envPath: dir,
    });

    expect(resolved).toBe(bin);
  });

  test("linux: does not resolve non-executable files", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "privoca-path-"));
    const bin = path.join(dir, "nope");
    fs.writeFileSync(bin, "echo hi\n", "utf8");
    fs.chmodSync(bin, 0o644);
    mockStatMode(bin, 0o100644);

    const resolved = resolveOnPathForPlatform("nope", {
      platform: "linux",
      envPath: dir,
    });

    expect(resolved).toBe(null);
  });

  test("win32: appends PATHEXT and supports already-suffixed commands", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "privoca-path-"));
    const exe = path.join(dir, "tool.exe");
    fs.writeFileSync(exe, "", "utf8");

    const envPath = dir;
    const pathext = ".EXE;.CMD";

    expect(
      resolveOnPathForPlatform("tool", {
        platform: "win32",
        envPath,
        pathext,
      })
    ).toBe(exe);

    expect(
      resolveOnPathForPlatform("tool.exe", {
        platform: "win32",
        envPath,
        pathext,
      })
    ).toBe(exe);
  });

  test("win32: supports quoted PATH entries", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "privoca path-"));
    const exe = path.join(dir, "quoted.exe");
    fs.writeFileSync(exe, "", "utf8");

    const envPath = `"${dir}"`;

    expect(
      resolveOnPathForPlatform("quoted", {
        platform: "win32",
        envPath,
        pathext: ".EXE",
      })
    ).toBe(exe);
  });
});
