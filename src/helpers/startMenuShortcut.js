const path = require("path");

/**
 * The first Windows toast we show makes the notification platform look for a per-user
 * Start Menu shortcut carrying our AppUserModelID. When it finds none it writes one
 * itself, and the name it derives loses its last character — that is where the
 * "PrivateTranscrib" entry in Windows Search comes from. The all-users shortcut the
 * installer writes does not satisfy the lookup, so we write the per-user one ourselves.
 */
function resolveStartMenuShortcutPaths({ appDataPath, appName }) {
  const programs = path.join(appDataPath, "Microsoft", "Windows", "Start Menu", "Programs");
  return {
    shortcutPath: path.join(programs, `${appName}.lnk`),
    strayPath: appName.length > 1 ? path.join(programs, `${appName.slice(0, -1)}.lnk`) : null,
  };
}

function ensureStartMenuShortcut({ appDataPath, appName, exePath, appUserModelId }) {
  const fs = require("fs");
  const { shell } = require("electron");
  const { shortcutPath, strayPath } = resolveStartMenuShortcutPaths({ appDataPath, appName });

  // Only remove the truncated shortcut once it is confirmed to point at our own binary,
  // so a same-named shortcut belonging to another app is never touched.
  if (strayPath && fs.existsSync(strayPath)) {
    let strayTarget = "";
    try {
      strayTarget = shell.readShortcutLink(strayPath).target || "";
    } catch {
      strayTarget = "";
    }
    if (strayTarget.toLowerCase() === exePath.toLowerCase()) {
      fs.rmSync(strayPath, { force: true });
    }
  }

  return shell.writeShortcutLink(shortcutPath, "create", {
    target: exePath,
    cwd: path.dirname(exePath),
    icon: exePath,
    iconIndex: 0,
    appUserModelId,
    description: appName,
  });
}

module.exports = { resolveStartMenuShortcutPaths, ensureStartMenuShortcut };
