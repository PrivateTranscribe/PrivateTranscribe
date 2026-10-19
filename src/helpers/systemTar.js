const path = require("path");
const { planAnsiArgvPaths } = require("./ansiArgvPaths");

// Windows 10 1803 and later ship bsdtar as System32\tar.exe. A bare "tar" can
// resolve to Git for Windows' GNU tar instead, when its usr\bin is on PATH, and
// GNU tar reads "C:\..." as host "C" and fails with "Cannot connect to C".
function getTarCommand(platform = process.platform, env = process.env) {
  if (platform !== "win32") return "tar";
  const systemRoot = env.SystemRoot || env.SYSTEMROOT || "C:\\Windows";
  return path.win32.join(systemRoot, "System32", "tar.exe");
}

/**
 * The spawn for extracting a .tar.bz2 archive into `destinationDir`.
 *
 * tar.exe reads its arguments in the ANSI code page, so under C:\Users\Ωmega or
 * C:\Users\李雷 it could not open the archive. Such paths go into the working
 * directory instead, and `cwd` is null when no change is needed.
 */
function getTarExtractSpawn(
  archivePath,
  destinationDir,
  { platform = process.platform, env = process.env } = {}
) {
  const plan = planAnsiArgvPaths([archivePath, destinationDir], { platform });
  const [archive, destination] = plan.paths;
  return {
    command: getTarCommand(platform, env),
    args: ["-xjf", archive, "-C", destination],
    cwd: plan.cwd,
  };
}

module.exports = { getTarCommand, getTarExtractSpawn };
