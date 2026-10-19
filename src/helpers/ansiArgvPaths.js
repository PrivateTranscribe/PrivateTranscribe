const path = require("path");

/**
 * File paths for native programs that read their command line in the Windows
 * ANSI code page.
 *
 * whisper-server and System32's tar.exe have a plain `main()`, so Windows hands
 * them argv converted from UTF-16 to the ANSI code page (1252 on Danish and
 * English Windows). A user folder outside ASCII does not survive that:
 * whisper-server aborts with 0xC0000409 on C:\Users\Søren, "Ωmega" arrives as
 * "Omega" and "李雷" as "??", and the file is never found. The working
 * directory is set through CreateProcessW and keeps every character, and these
 * programs open a relative name against it with wide APIs.
 *
 * So a path that is not ASCII moves into the working directory: the program
 * starts in the deepest folder the paths share and gets each path relative to
 * it. The file and folder names we pass are our own and ASCII (ggml-base.bin,
 * temp-extract-...), so the relative form is too. 8.3 short names were the
 * alternative, but they depend on a per-volume setting, and Windows gave a
 * folder named "Ωmega" none at all.
 *
 * Programs that already take Unicode arguments (ffmpeg, llama-server, the
 * Electron utility processes) do not need this; each was checked against
 * Søren, Ωmega and 李雷 folders.
 */

/** True when `value` reaches a narrow main() unchanged on every ANSI code page. */
function isAsciiPath(value) {
  return /^[\x20-\x7e]*$/.test(String(value));
}

function isInside(child, parent) {
  const relative = path.win32.relative(parent, child);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith("..\\") && !path.win32.isAbsolute(relative))
  );
}

/** The deepest folder holding every one of `folders`, or null when they span drives. */
function sharedFolder(folders) {
  let base = folders[0];
  for (const folder of folders.slice(1)) {
    while (!isInside(folder, base)) {
      const parent = path.win32.dirname(base);
      if (parent === base) return null;
      base = parent;
    }
  }
  return base;
}

/**
 * Plan how to pass `filePaths` to such a program.
 *
 * @param {string[]} filePaths absolute paths, in argument order
 * @returns {{ cwd: string | null, paths: string[] }} `paths` replaces the input
 *   one for one. `cwd` is the working directory they are relative to, or null
 *   when they go through unchanged and the caller keeps its own.
 */
function planAnsiArgvPaths(filePaths, { platform = process.platform } = {}) {
  const unchanged = { cwd: null, paths: [...filePaths] };
  if (platform !== "win32" || filePaths.length === 0 || filePaths.every(isAsciiPath)) {
    return unchanged;
  }

  const cwd = sharedFolder(filePaths.map((filePath) => path.win32.dirname(filePath)));
  if (!cwd) return unchanged;

  const paths = filePaths.map((filePath) => path.win32.relative(cwd, filePath) || ".");
  // A non-ASCII name of our own would still be mangled; passing it as before is
  // no worse than any other choice left.
  return paths.every(isAsciiPath) ? { cwd, paths } : unchanged;
}

module.exports = { isAsciiPath, planAnsiArgvPaths };
