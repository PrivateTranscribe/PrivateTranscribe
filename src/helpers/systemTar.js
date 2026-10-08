const path = require("path");

// Windows 10 1803 and later ship bsdtar as System32\tar.exe. A bare "tar" can
// resolve to Git for Windows' GNU tar instead, when its usr\bin is on PATH, and
// GNU tar reads "C:\..." as host "C" and fails with "Cannot connect to C".
function getTarCommand(platform = process.platform, env = process.env) {
  if (platform !== "win32") return "tar";
  const systemRoot = env.SystemRoot || env.SYSTEMROOT || "C:\\Windows";
  return path.win32.join(systemRoot, "System32", "tar.exe");
}

module.exports = { getTarCommand };
