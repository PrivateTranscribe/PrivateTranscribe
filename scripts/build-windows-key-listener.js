#!/usr/bin/env node
/**
 * Builds the Windows key listener from resources/windows-key-listener.c.
 *
 * The binary is always compiled from the source in this checkout. There used to
 * be a fallback that downloaded the latest prebuilt listener from this repo's
 * releases, with no pinned version and no checksum. That build came from
 * whatever source was last pushed, not this checkout, and the release job
 * signs the listener, so it is gone.
 *
 * Without a compiler, a local build keeps the binary it has (or none, and
 * push-to-talk falls back to tap mode) and says so. In CI it fails instead, so
 * no installer ships without a listener built from its own source.
 */

const fs = require("fs");
const path = require("path");
const { compileKeyListener } = require("./lib/compile-key-listener");

const projectRoot = path.resolve(__dirname, "..");
const cSource = path.join(projectRoot, "resources", "windows-key-listener.c");
const outputDir = path.join(projectRoot, "resources", "bin");
const outputBinary = path.join(outputDir, "windows-key-listener.exe");

function log(message) {
  console.log(`[windows-key-listener] ${message}`);
}

function isBinaryUpToDate() {
  if (!fs.existsSync(outputBinary)) {
    return false;
  }
  try {
    return fs.statSync(outputBinary).mtimeMs >= fs.statSync(cSource).mtimeMs;
  } catch {
    return false;
  }
}

function main() {
  // Only needed on Windows
  if (process.platform !== "win32") return;

  if (isBinaryUpToDate()) {
    log("Binary is up to date, skipping build");
    return;
  }

  fs.mkdirSync(outputDir, { recursive: true });
  log("Compiling from source...");
  const { compiler } = compileKeyListener({ source: cSource, output: outputBinary, log });
  if (compiler) {
    log(`Successfully built with ${compiler}`);
    return;
  }

  const isCi = process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true";
  console.warn("[windows-key-listener] Could not compile the Windows key listener.");
  console.warn(
    "[windows-key-listener] To compile locally, install Visual Studio Build Tools with the C++ workload, or MinGW-w64."
  );
  if (isCi) {
    console.error("[windows-key-listener] Refusing to build without it in CI.");
    process.exitCode = 1;
  } else if (fs.existsSync(outputBinary)) {
    console.warn(
      "[windows-key-listener] Keeping the existing binary, which was built from older source."
    );
  } else {
    console.warn("[windows-key-listener] Push-to-Talk on Windows will use fallback mode.");
  }
}

if (require.main === module) {
  main();
}

module.exports = { main };
