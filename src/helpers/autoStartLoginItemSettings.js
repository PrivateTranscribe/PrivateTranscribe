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

// Directories the OS is free to delete under us. A dev run started from one of these —
// an editor scratch copy, an agent session sandbox, an unpacked archive — registers a Run
// entry whose app path is gone by the next login, and Windows greets the user with
// Electron's "Unable to find Electron app" dialog on every boot.
const EPHEMERAL_PATH_SEGMENTS = [
  "/appdata/local/temp/",
  "/windows/temp/",
  "/var/folders/", // macOS per-user temp
];
const EPHEMERAL_PATH_ROOTS = ["/tmp/"];

function toComparablePath(value) {
  const normalized = String(value || "")
    .replace(/^"|"$/g, "")
    .replace(/\\/g, "/")
    .toLowerCase();
  return normalized.endsWith("/") ? normalized : `${normalized}/`;
}

function isEphemeralAppPath(appPath, env = process.env) {
  const target = toComparablePath(appPath);
  if (target === "/") {
    return false;
  }

  // TEMP/TMP can be the 8.3 short form (USERNA~1) while appPath is long, or the reverse,
  // so the literal segments above still have to carry the check on their own.
  const roots = [env?.TEMP, env?.TMP, env?.TMPDIR]
    .filter(Boolean)
    .map(toComparablePath)
    .filter((root) => root !== "/")
    .concat(EPHEMERAL_PATH_ROOTS);

  return (
    roots.some((root) => target.startsWith(root)) ||
    EPHEMERAL_PATH_SEGMENTS.some((segment) => target.includes(segment))
  );
}

/**
 * Whether it is safe to write a login item for this run.
 *
 * Packaged installs always are. A Windows dev run puts the app path in the Run key args
 * (see buildAutoStartLaunchOptions), so it must refuse when that path is somewhere the OS
 * will clean up. Other platforms never register the app path, so there is nothing to rot.
 */
function canRegisterAutoStart({
  platform = process.platform,
  isPackaged = true,
  appPath = "",
  env = process.env,
} = {}) {
  if (isPackaged || platform !== "win32") {
    return true;
  }

  return Boolean(appPath) && !isEphemeralAppPath(appPath, env);
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
 * This is the fallback path. Windows callers should prefer readAutoStartRegistryState in
 * windowsAutoStartRegistry.js, which reads the Run key and the StartupApproved flag itself.
 *
 * `executableWillLaunchAtLogin` used to be preferred here because it folds in the
 * StartupApproved flag. It cannot be trusted: on a real install it reports true while the
 * Run key holds no entry for the app at all. That pinned the settings toggle to "on", so
 * every attempt to switch it read back as a failed write and auto-start could never be
 * turned on for real. `openAtLogin` at least reflects an actual Run value.
 */
function resolveAutoStartEnabled(loginItemSettings, platform = process.platform) {
  if (!loginItemSettings) {
    return false;
  }

  return Boolean(loginItemSettings.openAtLogin);
}

module.exports = {
  AUTO_START_LAUNCH_MODES,
  DEFAULT_AUTO_START_LAUNCH_MODE,
  normalizeAutoStartLaunchMode,
  buildAutoStartLaunchOptions,
  buildAutoStartSetOptions,
  canRegisterAutoStart,
  isEphemeralAppPath,
  findAutoStartLaunchItem,
  getAutoStartApprovalState,
  resolveAutoStartEnabled,
};
