#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const {
  downloadFile,
  extractZip,
  parseArgs,
  setExecutable,
  cleanupFiles,
  verifySha256,
} = require("./lib/download-utils");

const WHISPER_CPP_REPO = "OpenWhispr/whisper.cpp";

/**
 * The whisper.cpp release this product ships, and the SHA-256 of each archive
 * below.
 *
 * Pinned and checked, not tracked. OpenWhispr/whisper.cpp is a third-party
 * fork, and the release job runs and signs whatever this script fetches. It
 * used to take that fork's latest release with no check of the bytes, so a new
 * upload reached a signed installer by timing rather than by decision. Now an
 * archive whose hash differs from the one recorded here is deleted before it
 * is extracted, and the script exits with an error, which fails the build.
 *
 * 0.0.10 is the release PrivateTranscribe 0.23.0 shipped. To bump: pick a tag
 * from https://github.com/OpenWhispr/whisper.cpp/releases, download each
 * archive below, hash it (`certutil -hashfile <zip> SHA256`), compare with the
 * asset's digest on GitHub, and change the tag and all four hashes together.
 */
const PINNED_VERSION = "0.0.10";

const BINARIES = {
  "darwin-arm64": {
    zipName: "whisper-server-darwin-arm64.zip",
    sha256: "6a5f794e42549d61e7b46e1c1f296f05ec6569bfcb81b7e39c14860021f477de",
    binaryName: "whisper-server-darwin-arm64",
    outputName: "whisper-server-darwin-arm64",
  },
  "darwin-x64": {
    zipName: "whisper-server-darwin-x64.zip",
    sha256: "000395055f5cf058562e4fb8a882b679657beb02d6cbd890cb336fa789365e14",
    binaryName: "whisper-server-darwin-x64",
    outputName: "whisper-server-darwin-x64",
  },
  "win32-x64": {
    zipName: "whisper-server-win32-x64-cpu.zip",
    sha256: "360c35ae259c75d8846de97fd0db499448ed019c04fb96dc3807ededd8b41f3f",
    binaryName: "whisper-server-win32-x64-cpu.exe",
    outputName: "whisper-server-win32-x64.exe",
  },
  "linux-x64": {
    zipName: "whisper-server-linux-x64-cpu.zip",
    sha256: "d10561f59eabb6e3273d721bc31e17092aa30ec543d9f3931e8ae04c58be6dd4",
    binaryName: "whisper-server-linux-x64-cpu",
    outputName: "whisper-server-linux-x64",
  },
};

const BIN_DIR = path.join(__dirname, "..", "resources", "bin");

// The release page's own download address. A pinned tag needs no API lookup,
// which also spares the anonymous api.github.com rate limit.
function getDownloadUrl(zipName) {
  return `https://github.com/${WHISPER_CPP_REPO}/releases/download/${PINNED_VERSION}/${zipName}`;
}

async function downloadBinary(platformArch, config, isForce = false) {
  if (!config) {
    console.log(`  [server] ${platformArch}: Not supported`);
    return false;
  }

  const outputPath = path.join(BIN_DIR, config.outputName);

  if (fs.existsSync(outputPath) && !isForce) {
    console.log(`  [server] ${platformArch}: Already exists (use --force to re-download)`);
    return true;
  }

  const url = getDownloadUrl(config.zipName);
  console.log(`  [server] ${platformArch}: Downloading from ${url}`);

  const zipPath = path.join(BIN_DIR, config.zipName);

  try {
    await downloadFile(url, zipPath);
    verifySha256(zipPath, config.sha256);

    const extractDir = path.join(BIN_DIR, `temp-whisper-${platformArch}`);
    fs.mkdirSync(extractDir, { recursive: true });
    extractZip(zipPath, extractDir);

    const binaryPath = path.join(extractDir, config.binaryName);
    if (fs.existsSync(binaryPath)) {
      fs.copyFileSync(binaryPath, outputPath);
      setExecutable(outputPath);
      // The CPU archive includes the Visual C++ runtime. A developer PC can
      // hide missing DLLs that prevent the packaged engine starting elsewhere.
      if (platformArch === "win32-x64") {
        for (const name of fs.readdirSync(extractDir)) {
          if (name.toLowerCase().endsWith(".dll")) {
            fs.copyFileSync(path.join(extractDir, name), path.join(BIN_DIR, name));
          }
        }
      }
      console.log(`  [server] ${platformArch}: Extracted to ${config.outputName}`);
    } else {
      console.error(`  [server] ${platformArch}: Binary not found in archive`);
      return false;
    }

    fs.rmSync(extractDir, { recursive: true, force: true });
    if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
    return true;
  } catch (error) {
    console.error(`  [server] ${platformArch}: Failed - ${error.message}`);
    if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
    return false;
  }
}

async function main() {
  // `npm run dev` runs this on every start, so a present engine must not need the network.
  const args = parseArgs();
  const currentConfig = args.isCurrent ? BINARIES[args.platformArch] : null;
  if (
    currentConfig &&
    !args.isForce &&
    fs.existsSync(path.join(BIN_DIR, currentConfig.outputName))
  ) {
    console.log(`[whisper-server] ${args.platformArch}: Already present, skipping the download`);
    return;
  }

  console.log(`\nDownloading whisper-server binaries (${PINNED_VERSION})...\n`);

  fs.mkdirSync(BIN_DIR, { recursive: true });

  if (args.isCurrent) {
    if (!BINARIES[args.platformArch]) {
      console.error(`Unsupported platform/arch: ${args.platformArch}`);
      process.exitCode = 1;
      return;
    }

    console.log(`Downloading for target platform (${args.platformArch}):`);
    const ok = await downloadBinary(args.platformArch, BINARIES[args.platformArch], args.isForce);
    if (!ok) {
      console.error(`Failed to download binaries for ${args.platformArch}`);
      process.exitCode = 1;
      return;
    }

    if (args.shouldCleanup) {
      cleanupFiles(BIN_DIR, "whisper-server", `whisper-server-${args.platformArch}`);
    }
  } else {
    console.log("Downloading binaries for all platforms:");
    for (const platformArch of Object.keys(BINARIES)) {
      if (!(await downloadBinary(platformArch, BINARIES[platformArch], args.isForce))) {
        process.exitCode = 1;
      }
    }
  }

  console.log("\n---");

  const files = fs.readdirSync(BIN_DIR).filter((f) => f.startsWith("whisper-server"));
  if (files.length > 0) {
    console.log("Available whisper-server binaries:\n");
    files.forEach((f) => {
      const stats = fs.statSync(path.join(BIN_DIR, f));
      console.log(`  - ${f} (${Math.round(stats.size / 1024 / 1024)}MB)`);
    });
  } else {
    console.log("No binaries downloaded yet.");
    console.log(`\nMake sure release exists: https://github.com/${WHISPER_CPP_REPO}/releases`);
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[whisper-server] ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { BINARIES, PINNED_VERSION, downloadBinary, getDownloadUrl, main };
