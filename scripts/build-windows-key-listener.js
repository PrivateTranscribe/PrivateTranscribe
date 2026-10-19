#!/usr/bin/env node
/**
 * Ensures the Windows key listener binary is available.
 *
 * Strategy:
 * 1. If binary exists and is up-to-date, do nothing
 * 2. If the local C source is present, compile it first, then fall back to the
 *    prebuilt download. Downloading first would fetch the OLD released binary and
 *    freshen its mtime, silently masking any fix made to the source.
 * 3. With no local source, download the prebuilt binary.
 *
 * This allows developers without a C compiler to still build the app.
 */

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { compileKeyListener } = require("./lib/compile-key-listener");

const isWindows = process.platform === "win32";
if (!isWindows) {
  // Only needed on Windows
  process.exit(0);
}

const projectRoot = path.resolve(__dirname, "..");
const cSource = path.join(projectRoot, "resources", "windows-key-listener.c");
const outputDir = path.join(projectRoot, "resources", "bin");
const outputBinary = path.join(outputDir, "windows-key-listener.exe");

function log(message) {
  console.log(`[windows-key-listener] ${message}`);
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

// Check if binary exists and is up-to-date
function isBinaryUpToDate() {
  if (!fs.existsSync(outputBinary)) {
    return false;
  }

  // If source doesn't exist, can't check if rebuild needed - assume binary is good
  if (!fs.existsSync(cSource)) {
    return true;
  }

  try {
    const binaryStat = fs.statSync(outputBinary);
    const sourceStat = fs.statSync(cSource);
    return binaryStat.mtimeMs >= sourceStat.mtimeMs;
  } catch {
    return false;
  }
}

// Try to download prebuilt binary
async function tryDownload() {
  log("Attempting to download prebuilt binary...");

  const downloadScript = path.join(__dirname, "download-windows-key-listener.js");
  if (!fs.existsSync(downloadScript)) {
    log("Download script not found, skipping download");
    return false;
  }

  const result = spawnSync(process.execPath, [downloadScript], {
    stdio: "inherit",
    cwd: projectRoot,
  });

  if (result.status === 0 && fs.existsSync(outputBinary)) {
    log("Successfully downloaded prebuilt binary");
    return true;
  }

  log("Download failed or binary not found after download");
  return false;
}

// Try to compile locally
function tryCompile() {
  if (!fs.existsSync(cSource)) {
    log("C source not found, cannot compile locally");
    return false;
  }

  log("Attempting local compilation...");
  const { compiler } = compileKeyListener({ source: cSource, output: outputBinary, log });
  if (compiler) {
    log(`Successfully built with ${compiler}`);
    return true;
  }
  return false;
}

async function main() {
  ensureDir(outputDir);

  // Check if rebuild is needed
  if (isBinaryUpToDate()) {
    log("Binary is up to date, skipping build");
    return;
  }

  // With a local C source present the binary is stale relative to that source, so
  // compiling is the only thing that can pick the change up. Downloading first
  // would replace it with the older released build and mark it fresh.
  const hasLocalSource = fs.existsSync(cSource);
  const steps = hasLocalSource ? [tryCompile, tryDownload] : [tryDownload, tryCompile];

  for (const step of steps) {
    const ok = await step();
    if (ok) {
      return;
    }
  }

  // Neither worked - warn but don't fail
  console.warn("[windows-key-listener] Could not obtain Windows key listener binary.");
  console.warn("[windows-key-listener] Push-to-Talk on Windows will use fallback mode.");
  console.warn(
    "[windows-key-listener] To compile locally, install Visual Studio Build Tools or MinGW-w64."
  );
}

main().catch((error) => {
  console.error("[windows-key-listener] Unexpected error:", error);
  // Don't fail the build
});
