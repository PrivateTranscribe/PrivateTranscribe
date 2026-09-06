import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";

describe.runIf(process.platform === "win32")("Windows paste observation deadline", () => {
  test("a blocked or throwing provider cannot block the input thread or process exit", () => {
    const compiler = path.join(
      process.env.WINDIR || "C:/Windows",
      "Microsoft.NET/Framework64/v4.0.30319/csc.exe"
    );
    const framework = path.dirname(compiler);
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "pt-paste-deadline-"));
    try {
      const executable = path.join(temp, "deadline.exe");
      const build = spawnSync(
        compiler,
        [
          "/nologo",
          "/target:exe",
          "/main:PasteDeadlineProbe",
          "/reference:System.Windows.Forms.dll",
          `/reference:${path.join(framework, "WPF/UIAutomationClient.dll")}`,
          `/reference:${path.join(framework, "WPF/UIAutomationTypes.dll")}`,
          `/out:${executable}`,
          path.resolve("resources/windows-fast-paste.cs"),
          path.resolve("tests/fixtures/windows-paste-deadline.cs"),
        ],
        { encoding: "utf8", windowsHide: true, timeout: 10000 }
      );
      expect(build.status, build.stdout + build.stderr).toBe(0);
      const run = spawnSync(executable, [], { encoding: "utf8", windowsHide: true, timeout: 2500 });
      expect(run.status, run.stderr || run.error?.message).toBe(0);
      expect(run.stdout).toBe("deadline-ok");
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });
});
