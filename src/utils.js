const fs = require("fs");
const path = require("path");
const os = require("os");
const { app } = require("electron");

class AppUtils {
  static cleanup(mainWindow) {
    console.log("Starting cleanup process...");

    const removeTarget = (target, label) => {
      try {
        if (fs.existsSync(target)) {
          fs.rmSync(target, { recursive: true, force: true });
          console.log(`✅ ${label} deleted:`, target);
        }
      } catch (error) {
        console.error(`❌ Error deleting ${label}:`, error);
      }
    };

    const userDataPath = app.getPath("userData");

    // User data deletion: database, logs, settings files, API key env file, device id, etc.
    removeTarget(userDataPath, "App data");

    // Local storage clearing
    if (mainWindow && mainWindow.webContents) {
      mainWindow.webContents
        .executeJavaScript("localStorage.clear()")
        .then(() => {
          console.log("✅ Local storage cleared");
        })
        .catch((error) => {
          console.error("❌ Error clearing local storage:", error);
        });
    }

    // Model cache deletion: Whisper, Parakeet, local GGUF/llama, diarization, and future model dirs.
    removeTarget(path.join(os.homedir(), ".cache", "PrivateTranscribe"), "Model caches");
    removeTarget(path.join(os.homedir(), ".cache", "Privoca"), "Legacy Privoca model caches");
    removeTarget(
      path.join(os.homedir(), ".cache", "dictatevoice"),
      "Legacy DictateVoice model caches"
    );
    removeTarget(path.join(os.homedir(), ".cache", "whisper"), "Legacy Whisper cache");

    // Permissions instruction
    console.log(
      "ℹ️ Please manually remove accessibility and microphone permissions via System Preferences if needed."
    );

    console.log("Cleanup process completed.");
  }
}

module.exports = AppUtils;
