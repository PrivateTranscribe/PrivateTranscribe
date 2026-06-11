function buildAutoStartLaunchOptions({
  platform = process.platform,
  isPackaged = true,
  execPath = process.execPath,
  appPath = "",
} = {}) {
  if (platform !== "win32") {
    return {};
  }

  const options = {
    path: execPath,
    args: [],
  };

  // In development, process.execPath is the Electron binary. Registering only
  // that executable makes Windows launch Electron without this app at login.
  // Passing the app path mirrors `electron .` so Start on boot is testable in dev.
  if (!isPackaged && appPath) {
    options.args = [appPath];
  }

  return options;
}

function buildAutoStartSetOptions({ enabled, platform = process.platform, ...launchOptions } = {}) {
  const options = {
    ...buildAutoStartLaunchOptions({ platform, ...launchOptions }),
    openAtLogin: Boolean(enabled),
  };

  // Electron only supports openAsHidden on macOS, and it is deprecated/no-op on
  // newer macOS versions. Keep it scoped to macOS so Windows registry entries do
  // not get irrelevant options.
  if (platform === "darwin") {
    options.openAsHidden = true;
  }

  return options;
}

module.exports = {
  buildAutoStartLaunchOptions,
  buildAutoStartSetOptions,
};
