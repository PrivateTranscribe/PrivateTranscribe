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

function buildAutoStartSetOptions({
  enabled,
  startupApproved,
  platform = process.platform,
  ...launchOptions
} = {}) {
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

  // Windows has two independent switches: the `Run` registry value, and the
  // `StartupApproved` flag that Task Manager and Windows Settings toggle. Electron's
  // `enabled` option defaults to true, so any write silently re-approves an entry the
  // user disabled in Task Manager. Always state it explicitly, and let callers carry
  // the existing approval forward when they are only rewriting the launch arguments.
  if (platform === "win32") {
    options.enabled = startupApproved === undefined ? Boolean(enabled) : Boolean(startupApproved);
  }

  return options;
}

function normalizeExecutablePath(value) {
  return String(value || "")
    .replace(/^"|"$/g, "")
    .replace(/\//g, "\\")
    .toLowerCase();
}

/**
 * Find the Windows Run-key entry that belongs to this executable, if any.
 * Returns null on other platforms and whenever no entry is registered.
 */
function findAutoStartLaunchItem(loginItemSettings, execPath = process.execPath) {
  const items = Array.isArray(loginItemSettings?.launchItems) ? loginItemSettings.launchItems : [];
  if (items.length === 0) {
    return null;
  }

  const target = normalizeExecutablePath(execPath);
  return items.find((item) => normalizeExecutablePath(item?.path) === target) || null;
}

/**
 * Windows startup approval state for this executable:
 * true = registered and approved, false = registered but disabled in Task Manager,
 * null = no registry entry at all (no user decision recorded yet).
 */
function getAutoStartApprovalState(loginItemSettings, execPath = process.execPath) {
  const item = findAutoStartLaunchItem(loginItemSettings, execPath);
  return item ? Boolean(item.enabled) : null;
}

/**
 * Whether the OS will actually launch the app at login.
 *
 * On Windows `openAtLogin` only reports whether the Run key exists — it stays true
 * after the user disables the entry in Task Manager or Windows Settings.
 * `executableWillLaunchAtLogin` folds in the StartupApproved flag, and ignores the
 * args option so installs registered before startup-mode args still resolve.
 */
function resolveAutoStartEnabled(loginItemSettings, platform = process.platform) {
  if (!loginItemSettings) {
    return false;
  }

  if (platform === "win32" && typeof loginItemSettings.executableWillLaunchAtLogin === "boolean") {
    return loginItemSettings.executableWillLaunchAtLogin;
  }

  return Boolean(loginItemSettings.openAtLogin);
}

module.exports = {
  AUTO_START_LAUNCH_MODES,
  DEFAULT_AUTO_START_LAUNCH_MODE,
  normalizeAutoStartLaunchMode,
  buildAutoStartLaunchOptions,
  buildAutoStartSetOptions,
  findAutoStartLaunchItem,
  getAutoStartApprovalState,
  resolveAutoStartEnabled,
};
