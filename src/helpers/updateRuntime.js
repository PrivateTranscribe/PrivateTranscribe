const path = require("path");

const MANUAL_INSTALL_URL = "https://privatetranscribe.com/download/windows";

function resolveUpdateRuntime({ isDevelopment, isPackaged, resourcesPath, configExists }) {
  if (isDevelopment) {
    return {
      automaticUpdatesAvailable: false,
      isDevelopment: true,
      manualInstallRequired: false,
      message: "Update checks are disabled in development mode",
    };
  }

  const updateConfigPath = resourcesPath ? path.join(resourcesPath, "app-update.yml") : null;
  const hasUpdateConfig = Boolean(isPackaged && updateConfigPath && configExists(updateConfigPath));

  if (!hasUpdateConfig) {
    return {
      automaticUpdatesAvailable: false,
      isDevelopment: false,
      manualInstallRequired: true,
      manualInstallUrl: MANUAL_INSTALL_URL,
      message:
        "This copy cannot update itself because it was not installed with the official installer. Download and run the official installer once to restore automatic updates.",
    };
  }

  return {
    automaticUpdatesAvailable: true,
    isDevelopment: false,
    manualInstallRequired: false,
    updateConfigPath,
  };
}

module.exports = {
  MANUAL_INSTALL_URL,
  resolveUpdateRuntime,
};
