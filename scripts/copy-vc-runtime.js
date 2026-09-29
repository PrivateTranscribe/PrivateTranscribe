#!/usr/bin/env node
/**
 * Copies one matched set of the Visual C++ runtime into resources/bin.
 *
 * The Parakeet engine's onnxruntime.dll and onnxruntime-node's (Read Aloud) import
 * msvcp140_1.dll, which no downloaded archive carries. Without it both start only on
 * PCs where the Visual C++ redistributable is installed. msvcp140_1.dll imports
 * msvcp140.dll, which imports both vcruntime DLLs, so all four come from one
 * redistributable and replace the copies the whisper.cpp archive brings.
 * electron-builder.json also puts them next to onnxruntime-node's onnxruntime.dll,
 * which looks for its dependencies in its own folder, never in resources/bin.
 *
 * Source: the newest Visual Studio redistributable folder
 * (VC\Redist\MSVC\<version>\x64\Microsoft.VC14x.CRT), so release builds take the
 * runtime from Visual Studio on their GitHub Actions runner. Outside CI, a PC
 * without a new enough Visual Studio may use the redistributable installed in
 * System32 instead. An older runtime never replaces a newer one: whisper.cpp and
 * ONNX Runtime were built with MSVC 14.44 and 14.40 and need at least that.
 */
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { readFileVersion } = require("./lib/pe-file");

const BIN_DIR = path.join(__dirname, "..", "resources", "bin");
const RUNTIME_DLLS = ["msvcp140.dll", "msvcp140_1.dll", "vcruntime140.dll", "vcruntime140_1.dll"];

const versionOf = (file) => readFileVersion(fs.readFileSync(file));
const formatVersion = (version) => version.join(".");

function compareVersions(a, b) {
  for (let i = 0; i < 4; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

/** Every x64 Microsoft.VC14x.CRT folder of every installed Visual Studio. */
function visualStudioRuntimeFolders() {
  const vswhere = path.join(
    process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)",
    "Microsoft Visual Studio",
    "Installer",
    "vswhere.exe"
  );
  if (!fs.existsSync(vswhere)) return [];
  const installs = execFileSync(
    vswhere,
    ["-all", "-products", "*", "-property", "installationPath"],
    { encoding: "utf8" }
  )
    .split(/\r?\n/)
    .filter(Boolean);
  return installs.flatMap((install) => {
    const redistDir = path.join(install, "VC", "Redist", "MSVC");
    if (!fs.existsSync(redistDir)) return [];
    return fs.readdirSync(redistDir).flatMap((version) => {
      const archDir = path.join(redistDir, version, "x64");
      if (!fs.existsSync(archDir)) return [];
      return fs
        .readdirSync(archDir)
        .filter((name) => /^Microsoft\.VC\d+\.CRT$/i.test(name))
        .map((name) => path.join(archDir, name));
    });
  });
}

/** The folder and version when it holds all four DLLs at one version, else null. */
function describeSource(folder) {
  const versions = RUNTIME_DLLS.map((name) => {
    const file = path.join(folder, name);
    return fs.existsSync(file) ? versionOf(file) : null;
  });
  if (versions.some((version) => !version)) return null;
  if (versions.some((version) => compareVersions(version, versions[0]) !== 0)) return null;
  return { folder, version: versions[0] };
}

function main() {
  if (process.platform !== "win32") {
    console.log("[vc-runtime] Only Windows builds ship the Visual C++ runtime; skipping");
    return;
  }

  const folders = visualStudioRuntimeFolders();
  // A release must not depend on what happens to be installed on the build machine.
  if (!process.env.CI) {
    folders.push(path.join(process.env.SystemRoot || "C:\\Windows", "System32"));
  }
  const sources = folders
    .map(describeSource)
    .filter(Boolean)
    .sort((a, b) => compareVersions(b.version, a.version));

  if (sources.length === 0) {
    console.error(
      "[vc-runtime] No Visual C++ runtime found. Install Visual Studio or its Build Tools " +
        "with the C++ workload" +
        (process.env.CI
          ? "; CI builds take the runtime from Visual Studio only."
          : ", or the Visual C++ 2015-2022 redistributable (x64).")
    );
    process.exitCode = 1;
    return;
  }

  const source = sources[0];
  const shipped = path.join(BIN_DIR, "msvcp140.dll");
  const shippedVersion = fs.existsSync(shipped) ? versionOf(shipped) : null;
  if (shippedVersion && compareVersions(source.version, shippedVersion) < 0) {
    console.error(
      `[vc-runtime] The newest runtime found, ${formatVersion(source.version)} in ` +
        `${source.folder}, is older than the ${formatVersion(shippedVersion)} already in ` +
        "resources/bin, which the engines may need. Update Visual Studio or the Visual C++ " +
        "redistributable."
    );
    process.exitCode = 1;
    return;
  }

  fs.mkdirSync(BIN_DIR, { recursive: true });
  for (const name of RUNTIME_DLLS) {
    const from = path.join(source.folder, name);
    const to = path.join(BIN_DIR, name);
    if (fs.existsSync(to) && fs.readFileSync(to).equals(fs.readFileSync(from))) continue;
    // Remove first, so a hardlinked old copy is replaced rather than written through.
    fs.rmSync(to, { force: true });
    fs.copyFileSync(from, to);
  }
  console.log(
    `[vc-runtime] ${RUNTIME_DLLS.join(", ")} ${formatVersion(source.version)} from ${source.folder}`
  );
}

main();
