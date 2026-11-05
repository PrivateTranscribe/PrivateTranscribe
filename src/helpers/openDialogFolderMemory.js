const path = require("path");

/**
 * Since Electron 43, dialog.showOpenDialog without a defaultPath opens in the
 * Downloads folder, and Windows no longer reopens the folder the user picked
 * from last time. This keeps that folder for the session, so a picker reopens
 * where the user left it, as it did before.
 */
function createOpenDialogFolderMemory() {
  let lastFolder;

  return {
    defaultPath(requested) {
      return typeof requested === "string" && requested ? requested : lastFolder;
    },
    remember(result) {
      const picked = result && !result.canceled ? result.filePaths?.[0] : undefined;
      if (typeof picked === "string" && picked) {
        lastFolder = path.dirname(picked);
      }
    },
  };
}

module.exports = { createOpenDialogFolderMemory };
