const os = require("os");
const fs = require("fs");
const path = require("path");

// The temp folder for files native tools read and write: FFmpeg's input and output,
// the Parakeet audio pieces, llama-server's working folder. It is the user's own
// temp folder, which other accounts on the PC cannot open.
//
// Up to 0.23.0 a TEMP path with a space or a letter outside ASCII (C:\Users\Søren)
// fell back to C:\ProgramData\PrivateTranscribe\temp, on the belief that
// whisper-server and FFmpeg could not take such paths. That folder inherits read
// access for every local account, so other people on the PC could open dictation
// audio. FFmpeg, whisper-server, llama-server and sherpa-onnx were checked with
// Søren, Ωmega and 李雷 temp folders, spaces included, and all take them. Do not
// bring a shared fallback back: a tool that needs ASCII paths gets ansiArgvPaths.js.
function getSafeTempDir() {
  return os.tmpdir();
}

// The exact names older versions gave their temp audio in the shared folders.
// whisperServer.js used a timestamp until April 2026 and a UUID since. Up to 0.21.1,
// parakeetServer.js wrote parakeet-input-<timestamp><ext> and parakeet-<timestamp>.wav.
const LEGACY_TEMP_FILE = new RegExp(
  "^(?:" +
    "whisper-(?:input|output|trimmed|speech|balanced)-[0-9a-f-]+\\.[a-z0-9]{3,4}" +
    "|parakeet-input-\\d+\\.[a-z0-9]{3,4}" +
    "|parakeet-\\d+\\.wav" +
    ")$",
  "i"
);

function getLegacySharedTempDirs(env = process.env) {
  return [
    path.join(env.ProgramData || "C:\\ProgramData", "PrivateTranscribe", "temp"),
    // Used when ProgramData could not be written.
    path.join(env.SystemDrive || "C:", "PrivateTranscribe", "temp"),
  ];
}

/** Lstat-based: a junction or symlink is never taken for the thing it points at. */
async function isReal(entryPath, kind) {
  const stat = await fs.promises.lstat(entryPath).catch(() => null);
  return Boolean(
    stat && !stat.isSymbolicLink() && (kind === "file" ? stat.isFile() : stat.isDirectory())
  );
}

/**
 * True when the path still leads straight to `file`. Run right before the unlink: a
 * folder on the way swapped for a junction since the checks above would send the
 * unlink into another folder.
 */
async function resolvesToItself(file) {
  const real = await fs.promises.realpath(file).catch(() => null);
  return real !== null && real.toLowerCase() === path.resolve(file).toLowerCase();
}

/**
 * Delete this user's leftover temp audio from the shared folders older versions used,
 * then the folders once empty. Each transcription deletes its own files, so only a crash
 * or a killed process leaves any. Never throws.
 *
 * Every account can create entries in these folders, links included, so the sweep never
 * follows a link, never descends into a folder, and deletes only regular files named
 * exactly like ours whose real path is the expected one. An unlink fails on another
 * account's file, which stays. Parakeet's leftover folders stay too: their files have
 * generic names (input.wav), and a folder another account owns could be swapped for a
 * junction while it was being emptied.
 *
 * @returns {Promise<number>} how many files were removed
 */
async function removeLegacySharedTemp({
  platform = process.platform,
  dirs = getLegacySharedTempDirs(),
} = {}) {
  if (platform !== "win32") return 0;

  let removed = 0;
  for (const dir of dirs) {
    if (!(await isReal(path.dirname(dir), "dir")) || !(await isReal(dir, "dir"))) continue;
    const names = await fs.promises.readdir(dir).catch(() => []);
    for (const name of names) {
      const file = path.join(dir, name);
      if (!LEGACY_TEMP_FILE.test(name) || !(await isReal(file, "file"))) continue;
      if (!(await resolvesToItself(file))) continue;
      const deleted = await fs.promises.unlink(file).then(
        () => true,
        () => false
      );
      if (deleted) removed += 1;
    }
    // rmdir only removes an empty folder, so anything else in it keeps it.
    await fs.promises.rmdir(dir).catch(() => {});
    await fs.promises.rmdir(path.dirname(dir)).catch(() => {});
  }
  return removed;
}

module.exports = { getSafeTempDir, getLegacySharedTempDirs, removeLegacySharedTemp };
