#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const {
  downloadFile,
  extractArchive,
  fetchReleaseByTag,
  findBinaryInDir,
  parseArgs,
  setExecutable,
  cleanupFiles,
} = require("./lib/download-utils");

const LLAMA_CPP_REPO = "ggml-org/llama.cpp";

/**
 * The llama.cpp build this product ships.
 *
 * Pinned, not tracked. Following "latest" broke the 0.15.0 release outright:
 * llama.cpp now marks a stub release (v0.2.0, one text file, no binaries) as
 * latest and publishes every real build as a b-numbered prerelease, so the
 * /latest endpoint returned a release with no llama-server in it and the
 * signed Windows build failed before it started. A pin also means a release
 * build is reproducible, and a new upstream binary lands in a signed installer
 * by decision rather than by timing.
 *
 * To bump: pick a tag from https://github.com/ggml-org/llama.cpp/releases,
 * confirm it carries the bin assets for every platform in BINARIES below, and
 * change this line. b10566 is what upstream's own nightly pointer named at the
 * time of pinning.
 */
const PINNED_VERSION = "b10566";

// Overridable so a different build can be tried without editing the pin.
const VERSION = process.env.LLAMA_CPP_VERSION || PINNED_VERSION;

// Asset name patterns to match in the release (version-independent)
const BINARIES = {
  "darwin-arm64": {
    assetPattern: /^llama-.*-bin-macos-arm64\.tar\.gz$/,
    binaryPath: "build/bin/llama-server",
    outputName: "llama-server-darwin-arm64",
    libPattern: "*.dylib",
  },
  "darwin-x64": {
    assetPattern: /^llama-.*-bin-macos-x64\.tar\.gz$/,
    binaryPath: "build/bin/llama-server",
    outputName: "llama-server-darwin-x64",
    libPattern: "*.dylib",
  },
  "win32-x64": {
    assetPattern: /^llama-.*-bin-win-cpu-x64\.zip$/,
    binaryPath: "build/bin/llama-server.exe",
    outputName: "llama-server-win32-x64.exe",
    libPattern: "*.dll",
  },
  "linux-x64": {
    assetPattern: /^llama-.*-bin-ubuntu-x64\.tar\.gz$/,
    binaryPath: "build/bin/llama-server",
    outputName: "llama-server-linux-x64",
    libPattern: "*.so*",
  },
};

const BIN_DIR = path.join(__dirname, "..", "resources", "bin");

// Cache the release info to avoid multiple API calls
let cachedRelease = null;

async function getRelease() {
  if (cachedRelease) return cachedRelease;
  cachedRelease = await fetchReleaseByTag(LLAMA_CPP_REPO, VERSION);
  return cachedRelease;
}

function findAsset(release, pattern) {
  return release?.assets?.find((a) => pattern.test(a.name));
}

function findLibrariesInDir(dir, pattern, maxDepth = 5, currentDepth = 0) {
  if (currentDepth >= maxDepth) return [];

  const results = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      results.push(...findLibrariesInDir(fullPath, pattern, maxDepth, currentDepth + 1));
    } else if (matchesPattern(entry.name, pattern)) {
      results.push(fullPath);
    }
  }

  return results;
}

function matchesPattern(filename, pattern) {
  // Handle patterns like "*.dylib", "*.dll", "*.so*"
  if (pattern === "*.dylib") {
    return filename.endsWith(".dylib");
  } else if (pattern === "*.dll") {
    return filename.endsWith(".dll");
  } else if (pattern === "*.so*") {
    // Match .so files with optional version suffix (e.g., libfoo.so, libfoo.so.1, libfoo.so.1.2.3)
    return /\.so(\.\d+)*$/.test(filename) || filename.endsWith(".so");
  }
  return false;
}

async function downloadBinary(platformArch, config, release, isForce = false) {
  if (!config) {
    console.log(`  ${platformArch}: Not supported`);
    return false;
  }

  const outputPath = path.join(BIN_DIR, config.outputName);

  if (fs.existsSync(outputPath) && !isForce) {
    console.log(`  ${platformArch}: Already exists (use --force to re-download)`);
    return true;
  }

  const asset = findAsset(release, config.assetPattern);
  if (!asset) {
    console.error(`  ${platformArch}: No matching asset found for pattern ${config.assetPattern}`);
    return false;
  }

  console.log(`  ${platformArch}: Downloading from ${asset.url}`);

  const zipPath = path.join(BIN_DIR, asset.name);

  try {
    await downloadFile(asset.url, zipPath);

    const extractDir = path.join(BIN_DIR, `temp-llama-${platformArch}`);
    fs.mkdirSync(extractDir, { recursive: true });
    extractArchive(zipPath, extractDir);

    const binaryName = path.basename(config.binaryPath);
    let binaryPath = path.join(extractDir, config.binaryPath);

    if (!fs.existsSync(binaryPath)) {
      binaryPath = findBinaryInDir(extractDir, binaryName);
    }

    if (binaryPath && fs.existsSync(binaryPath)) {
      fs.copyFileSync(binaryPath, outputPath);
      setExecutable(outputPath);
      console.log(`  ${platformArch}: Extracted to ${config.outputName}`);

      // Copy shared libraries (dylib/dll/so files)
      if (config.libPattern) {
        const libraries = findLibrariesInDir(extractDir, config.libPattern);

        for (const libPath of libraries) {
          const libName = path.basename(libPath);
          const destPath = path.join(BIN_DIR, libName);

          // A forced refresh must replace the matching runtime too. Keeping
          // old ggml/llama DLLs beside a new launcher can prevent it starting.
          if (isForce || !fs.existsSync(destPath)) {
            fs.copyFileSync(libPath, destPath);
            setExecutable(destPath);
            console.log(`  ${platformArch}: Copied library ${libName}`);
          }
        }
      }
    } else {
      console.error(`  ${platformArch}: Binary '${binaryName}' not found in archive`);
      return false;
    }

    fs.rmSync(extractDir, { recursive: true, force: true });
    if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
    return true;
  } catch (error) {
    console.error(`  ${platformArch}: Failed - ${error.message}`);
    if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
    return false;
  }
}

async function main() {
  console.log(`\n[llama-server] Using pinned version: ${VERSION}`);
  const release = await getRelease();

  if (!release) {
    console.error(`[llama-server] No release tagged ${VERSION} in ${LLAMA_CPP_REPO}`);
    console.error("Upstream removes old build tags. Pick a current one and update PINNED_VERSION:");
    console.error(`  https://github.com/${LLAMA_CPP_REPO}/releases`);
    process.exitCode = 1;
    return;
  }

  console.log(`\nDownloading llama-server binaries (${release.tag})...\n`);

  fs.mkdirSync(BIN_DIR, { recursive: true });

  const args = parseArgs();

  if (args.isCurrent) {
    if (!BINARIES[args.platformArch]) {
      console.error(`Unsupported platform/arch: ${args.platformArch}`);
      process.exitCode = 1;
      return;
    }

    console.log(`Downloading for target platform (${args.platformArch}):`);
    const ok = await downloadBinary(
      args.platformArch,
      BINARIES[args.platformArch],
      release,
      args.isForce
    );
    if (!ok) {
      console.error(`Failed to download binaries for ${args.platformArch}`);
      process.exitCode = 1;
      return;
    }

    if (args.shouldCleanup) {
      cleanupFiles(BIN_DIR, "llama-server", `llama-server-${args.platformArch}`);
    }
  } else {
    console.log("Downloading binaries for all platforms:");
    for (const platformArch of Object.keys(BINARIES)) {
      await downloadBinary(platformArch, BINARIES[platformArch], release, args.isForce);
    }
  }

  console.log("\n---");

  const files = fs.readdirSync(BIN_DIR).filter((f) => f.startsWith("llama-server"));
  if (files.length > 0) {
    console.log("Available llama-server binaries:\n");
    files.forEach((f) => {
      const stats = fs.statSync(path.join(BIN_DIR, f));
      console.log(`  - ${f} (${Math.round(stats.size / 1024 / 1024)}MB)`);
    });
  } else {
    console.log("No binaries downloaded yet.");
    console.log(`\nMake sure release exists: https://github.com/${LLAMA_CPP_REPO}/releases`);
  }
}

main().catch(console.error);
