import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * --release-only sends a key-up only for the keys Windows reports as down.
 * A key-up for a key that is already up is not harmless: an unmatched
 * XBUTTONUP can make the focused window go Back, and a lone Alt or Win key-up
 * can open a menu.
 *
 * This never runs windows-hold-key.exe, which would send real input on the
 * PC running the suite. It compiles the helper's source with a probe as the
 * entry point instead. The probe hands the decision a fake key state and
 * prints what would get a key-up; nothing in it calls SendInput or reads the
 * real keyboard.
 */

const repoRoot = path.join(__dirname, "..", "..", "..");
const source = path.join(repoRoot, "resources", "windows-hold-key.cs");
const windowsDir = process.env.WINDIR || "C:\\Windows";
const compiler = [
  path.join(windowsDir, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe"),
  path.join(windowsDir, "Microsoft.NET", "Framework", "v4.0.30319", "csc.exe"),
].find((candidate) => process.platform === "win32" && fs.existsSync(candidate));

const PROBE = `
using System;
using System.Collections.Generic;

internal static class ReleaseOnlyProbe
{
    // probe <combination> <down virtual-key codes, comma-separated hex>
    public static int Main(string[] args)
    {
        var keys = WindowsHoldKey.ParseCombination(args[0]);
        var down = new HashSet<int>();
        if (args.Length > 1 && args[1].Length > 0)
        {
            foreach (string code in args[1].Split(','))
            {
                down.Add(Convert.ToInt32(code, 16));
            }
        }
        foreach (var held in WindowsHoldKey.KeysStillDown(keys, vk => down.Contains(vk)))
        {
            Console.Out.WriteLine("0x" + WindowsHoldKey.StateKeyOf(held).ToString("x2"));
        }
        return 0;
    }
}
`;

let workDir = "";
let probeExe = "";

beforeAll(() => {
  if (!compiler) return;
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-hold-key-probe-"));
  const probeSource = path.join(workDir, "probe.cs");
  probeExe = path.join(workDir, "probe.exe");
  fs.writeFileSync(probeSource, PROBE);
  const built = spawnSync(
    compiler,
    [
      "/nologo",
      "/target:exe",
      "/main:ReleaseOnlyProbe",
      "/reference:System.Windows.Forms.dll",
      `/out:${probeExe}`,
      source,
      probeSource,
    ],
    { encoding: "utf8" }
  );
  if (built.status !== 0) {
    throw new Error(`probe did not compile:\n${built.stdout}${built.stderr}`);
  }
});

afterAll(() => {
  if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
});

function keyUpsFor(combination: string, down: number[]) {
  const result = spawnSync(
    probeExe,
    [combination, down.map((code) => code.toString(16)).join(",")],
    { encoding: "utf8" }
  );
  expect(result.status).toBe(0);
  return result.stdout.trim().split(/\r?\n/).filter(Boolean);
}

describe.runIf(Boolean(compiler))("--release-only", () => {
  it("sends nothing for a combination that is already up", () => {
    expect(keyUpsFor("CommandOrControl+Shift+M", [])).toEqual([]);
    expect(keyUpsFor("Alt", [])).toEqual([]);
    expect(keyUpsFor("Super+P", [])).toEqual([]);
  });

  it("releases each key a killed helper left down, and only those", () => {
    expect(keyUpsFor("CommandOrControl+Shift+M", [0xa2, 0xa0, 0x4d])).toEqual([
      "0xa2",
      "0xa0",
      "0x4d",
    ]);
    expect(keyUpsFor("CommandOrControl+Shift+M", [0xa2])).toEqual(["0xa2"]);
  });

  it("never sends an unmatched mouse button up, which can make a window go Back", () => {
    expect(keyUpsFor("Mouse4", [])).toEqual([]);
    expect(keyUpsFor("Mouse5", [0x05])).toEqual([]);
    expect(keyUpsFor("Mouse4", [0x05])).toEqual(["0x05"]);
    expect(keyUpsFor("Mouse5", [0x06])).toEqual(["0x06"]);
    expect(keyUpsFor("Mouse3", [0x04])).toEqual(["0x04"]);
  });
});
