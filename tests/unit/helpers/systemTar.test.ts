import { describe, expect, it } from "vitest";

/**
 * The Parakeet and diarization downloads extract .tar.bz2 archives to C:\ paths.
 * Git for Windows' GNU tar, when first on PATH, reads "C:" as a remote host, so
 * Windows must always get its own bsdtar.
 */

const { getTarCommand } = require("../../../src/helpers/systemTar");

describe("getTarCommand", () => {
  it("uses System32 tar on Windows", () => {
    expect(getTarCommand("win32", { SystemRoot: "C:\\Windows" })).toBe(
      "C:\\Windows\\System32\\tar.exe"
    );
  });

  it("follows a Windows install on another drive", () => {
    expect(getTarCommand("win32", { SystemRoot: "D:\\WINDOWS" })).toBe(
      "D:\\WINDOWS\\System32\\tar.exe"
    );
  });

  it("falls back to C:\\Windows when SystemRoot is unset", () => {
    expect(getTarCommand("win32", {})).toBe("C:\\Windows\\System32\\tar.exe");
  });

  it("uses tar from PATH elsewhere", () => {
    expect(getTarCommand("linux", {})).toBe("tar");
    expect(getTarCommand("darwin", {})).toBe("tar");
  });
});
