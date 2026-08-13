#!/usr/bin/env node
/**
 * Compiles the Windows hold-key helper (resources/windows-hold-key.cs).
 *
 * Uses the C# compiler that ships inside every .NET Framework 4 install, the
 * same approach as the other native helpers, so contributors do not need
 * Visual Studio or any other toolchain.
 *
 * Missing the compiler is not fatal. Without this binary PrivateTranscribe
 * cannot drive a voice app's push-to-mute keybind, so auto-mute stays off and
 * dictation behaves exactly as it did before the feature existed.
 */

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

if (process.platform !== "win32") {
  process.exit(0);
}

const projectRoot = path.resolve(__dirname, "..");
const sourcePath = path.join(projectRoot, "resources", "windows-hold-key.cs");
const outputDir = path.join(projectRoot, "resources", "bin");
const outputPath = path.join(outputDir, "windows-hold-key.exe");
const windowsDir = process.env.WINDIR || "C:\\Windows";

const compilerCandidates = [
  path.join(windowsDir, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe"),
  path.join(windowsDir, "Microsoft.NET", "Framework", "v4.0.30319", "csc.exe"),
];

function log(message) {
  console.log(`[windows-hold-key] ${message}`);
}

function isUpToDate() {
  if (!fs.existsSync(sourcePath) || !fs.existsSync(outputPath)) return false;
  return fs.statSync(outputPath).mtimeMs >= fs.statSync(sourcePath).mtimeMs;
}

if (!fs.existsSync(sourcePath)) {
  console.warn("[windows-hold-key] Source not found, skipping build");
  process.exit(0);
}

if (isUpToDate()) {
  log("Binary is up to date, skipping build");
  process.exit(0);
}

const compilerPath = compilerCandidates.find((candidate) => fs.existsSync(candidate));
if (!compilerPath) {
  fs.rmSync(outputPath, { force: true });
  console.warn("[windows-hold-key] .NET Framework C# compiler was not found.");
  console.warn("[windows-hold-key] Auto-mute while dictating will be unavailable.");
  process.exit(0);
}

fs.mkdirSync(outputDir, { recursive: true });

const result = spawnSync(
  compilerPath,
  [
    "/nologo",
    "/optimize+",
    "/target:exe",
    "/reference:System.Windows.Forms.dll",
    `/out:${outputPath}`,
    sourcePath,
  ],
  { cwd: projectRoot, stdio: "inherit", shell: false }
);

if (result.status !== 0 || !fs.existsSync(outputPath)) {
  fs.rmSync(outputPath, { force: true });
  console.warn("[windows-hold-key] Compilation failed.");
  console.warn("[windows-hold-key] Auto-mute while dictating will be unavailable.");
  process.exit(0);
}

log(`Built ${outputPath}`);
