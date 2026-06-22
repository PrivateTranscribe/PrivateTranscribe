const AUTO_START_LAUNCH_MODES = ["tray", "minimized", "window"];
const DEFAULT_AUTO_START_LAUNCH_MODE = "tray";

function normalizeAutoStartLaunchMode(mode) {
  return AUTO_START_LAUNCH_MODES.includes(mode) ? mode : DEFAULT_AUTO_START_LAUNCH_MODE;
}

function buildAutoStartLaunchOptions({
  platform = process.platform,
  isPackaged = true,
  execPath = process.execPath,
  appPath = "",
  launchMode = DEFAULT_AUTO_START_LAUNCH_MODE,
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

  options.args.push(
    "--launch-at-login",
    `--startup-mode=${normalizeAutoStartLaunchMode(launchMode)}`
  );

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
  AUTO_START_LAUNCH_MODES,
  DEFAULT_AUTO_START_LAUNCH_MODE,
  normalizeAutoStartLaunchMode,
  buildAutoStartLaunchOptions,
  buildAutoStartSetOptions,
};
