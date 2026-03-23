const { app } = require("electron");
const os = require("os");
const path = require("path");
const fs = require("fs");

const OLD_CACHE_DIR = "Privoca";
const NEW_CACHE_DIR = "PrivateTranscribe";

/**
 * Migrate models from old .cache/Privoca dir to .cache/PrivateTranscribe if needed.
 * Safe to call multiple times — no-ops if already migrated.
 */
function migrateModelDirIfNeeded() {
  try {
    const homeDir = app?.getPath?.("home") || os.homedir();
    const oldBase = path.join(homeDir, ".cache", OLD_CACHE_DIR);
    const newBase = path.join(homeDir, ".cache", NEW_CACHE_DIR);

    if (!fs.existsSync(oldBase)) return;
    if (fs.existsSync(newBase)) return; // already migrated

    fs.mkdirSync(newBase, { recursive: true });

    // Move each service subfolder (e.g. whisper-models, llama-models)
    for (const entry of fs.readdirSync(oldBase)) {
      const src = path.join(oldBase, entry);
      const dest = path.join(newBase, entry);
      try {
        fs.renameSync(src, dest);
      } catch {
        // renameSync fails across filesystems — fall back to copy+delete
        fs.cpSync(src, dest, { recursive: true });
        fs.rmSync(src, { recursive: true, force: true });
      }
    }

    // Remove old dir if now empty
    try {
      fs.rmdirSync(oldBase);
    } catch {
      // Not empty or already gone — fine
    }
  } catch (err) {
    // Migration failure is non-fatal; log and continue
    console.warn("[modelDirUtils] Migration failed:", err.message);
  }
}

function getModelsDirForService(service) {
  const homeDir = app?.getPath?.("home") || os.homedir();
  return path.join(homeDir, ".cache", NEW_CACHE_DIR, `${service}-models`);
}

module.exports = { getModelsDirForService, migrateModelDirIfNeeded };
