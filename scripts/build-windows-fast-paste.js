#!/usr/bin/env node
/**
 * Compiles the Windows fast paste helper (resources/windows-fast-paste.cs).
 *
 * The helper is built with the C# compiler that ships inside every .NET
 * Framework 4 install, so contributors do not need Visual Studio, MinGW, or any
 * other toolchain. It references nothing beyond the default assemblies.
 *
 * Missing the compiler is not fatal: PrivateTranscribe falls back to nircmd or
 * PowerShell with a plain Ctrl+V, which is what it did before this helper
 * existed. Release builds assert that the binary is present (see the workflows
 * under .github/workflows).
 */

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

if (process.platform !== "win32") {
  process.exit(0);
}

const projectRoot = path.resolve(__dirname, "..");
const sourcePath = path.join(projectRoot, "resources", "windows-fast-paste.cs");
const outputDir = path.join(projectRoot, "resources", "bin");
const outputPath = path.join(outputDir, "windows-fast-paste.exe");
const windowsDir = process.env.WINDIR || "C:\\Windows";

const compilerCandidates = [
  path.join(windowsDir, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe"),
  path.join(windowsDir, "Microsoft.NET", "Framework", "v4.0.30319", "csc.exe"),
];

function log(message) {
  console.log(`[windows-fast-paste] ${message}`);
}

function isUpToDate() {
  if (!fs.existsSync(sourcePath) || !fs.existsSync(outputPath)) return false;
  return fs.statSync(outputPath).mtimeMs >= fs.statSync(sourcePath).mtimeMs;
}

if (!fs.existsSync(sourcePath)) {
  console.warn("[windows-fast-paste] Source not found, skipping build");
  process.exit(0);
}

if (isUpToDate()) {
  log("Binary is up to date, skipping build");
  process.exit(0);
}

const compilerPath = compilerCandidates.find((candidate) => fs.existsSync(candidate));
if (!compilerPath) {
  console.warn("[windows-fast-paste] .NET Framework C# compiler was not found.");
  console.warn(
    "[windows-fast-paste] Auto-paste will fall back to Ctrl+V without terminal support."
  );
  process.exit(0);
}

fs.mkdirSync(outputDir, { recursive: true });

const result = spawnSync(
  compilerPath,
  ["/nologo", "/optimize+", "/target:exe", `/out:${outputPath}`, sourcePath],
  { cwd: projectRoot, stdio: "inherit", shell: false }
);

if (result.status !== 0 || !fs.existsSync(outputPath)) {
  console.warn("[windows-fast-paste] Compilation failed.");
  console.warn(
    "[windows-fast-paste] Auto-paste will fall back to Ctrl+V without terminal support."
  );
  process.exit(0);
}

log(`Built ${outputPath}`);
