const path = require("path");
const fs = require("fs");
const { app, safeStorage } = require("electron");

/**
 * API keys that contain secrets and must be stored encrypted.
 * Everything else (provider selection, model names, hotkeys) is non-sensitive
 * and continues to live in a plain .env file.
 */
const SECRET_ENV_KEYS = new Set([
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GEMINI_API_KEY",
  "GROQ_API_KEY",
  "CUSTOM_TRANSCRIPTION_API_KEY",
  "CUSTOM_REASONING_API_KEY",
]);

/**
 * Non-secret settings persisted across restarts via a plain .env file.
 * These are safe to store in clear text because they contain no credentials.
 */
const PLAIN_ENV_KEYS = [
  "LOCAL_TRANSCRIPTION_PROVIDER",
  "PARAKEET_MODEL",
  "LOCAL_WHISPER_MODEL",
  "REASONING_PROVIDER",
  "LOCAL_REASONING_MODEL",
  "DICTATION_KEY",
];

class EnvironmentManager {
  constructor() {
    this._encryptedStorePath = path.join(app.getPath("userData"), "keys.enc");
    this._plainEnvPath = path.join(app.getPath("userData"), ".env");
    this._encryptionAvailable = safeStorage.isEncryptionAvailable();
    this.loadEnvironmentVariables();
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Boot-time loading
  // ──────────────────────────────────────────────────────────────────────────

  loadEnvironmentVariables() {
    // 1. Load plain settings from .env (non-secrets + legacy fallback).
    this._loadPlainEnvFile();

    // 2. Load secrets from encrypted store (overrides any .env fallback).
    if (this._encryptionAvailable) {
      this._loadEncryptedStore();
    } else {
      // Encryption unavailable (e.g. headless Linux without a keyring).
      // Plain .env already loaded above; nothing more to do.
    }
  }

  /**
   * Attempt to load the encrypted key store and populate process.env.
   * Silently ignores a missing file (first run) or a corrupt file (returns
   * early so existing process.env values from the .env fallback stand).
   */
  _loadEncryptedStore() {
    try {
      if (!fs.existsSync(this._encryptedStorePath)) return;
      const cipherBuf = fs.readFileSync(this._encryptedStorePath);
      const jsonStr = safeStorage.decryptString(cipherBuf);
      const parsed = JSON.parse(jsonStr);
      if (parsed && typeof parsed === "object") {
        for (const [key, value] of Object.entries(parsed)) {
          if (SECRET_ENV_KEYS.has(key) && typeof value === "string") {
            process.env[key] = value;
          }
        }
      }
    } catch {
      // Corrupt file or decryption failure — keep whatever plain-env loaded.
    }
  }

  /**
   * Write all current secret values to the encrypted store.
   * Called after every key save to keep the store in sync.
   */
  _persistEncryptedStore() {
    if (!this._encryptionAvailable) return;
    const secrets = {};
    for (const key of SECRET_ENV_KEYS) {
      if (process.env[key]) secrets[key] = process.env[key];
    }
    try {
      const cipherBuf = safeStorage.encryptString(JSON.stringify(secrets));
      fs.writeFileSync(this._encryptedStorePath, cipherBuf);
    } catch (err) {
      // Non-fatal: in-memory value already set; worst case the key is gone on
      // next restart and the user re-enters it.
      console.error("Failed to persist encrypted key store:", err.message);
    }
  }

  /**
   * Load the plain .env file.  Tries the userData path first; on first run the
   * file won't exist there, so falls back to legacy development/resource paths.
   */
  _loadPlainEnvFile() {
    const candidates = [
      this._plainEnvPath,
      // Development
      path.join(__dirname, "..", ".env"),
      // Production legacy paths
      path.join(process.resourcesPath, ".env"),
      path.join(process.resourcesPath, "app.asar.unpacked", ".env"),
      path.join(process.resourcesPath, "app", ".env"),
    ];
    for (const envPath of candidates) {
      try {
        if (fs.existsSync(envPath)) {
          const result = require("dotenv").config({ path: envPath });
          if (!result.error) break;
        }
      } catch {
        // Try next candidate.
      }
    }
  }

  /**
   * Write non-secret settings to the plain .env file.
   * Secrets are intentionally omitted here; they live in the encrypted store.
   * On platforms where encryption is unavailable, secrets are included as a
   * safe fallback so the app remains functional.
   */
  _persistPlainEnvFile() {
    let content = `# PrivateTranscribe — non-secret settings\n# Generated automatically — do not edit manually.\n`;
    const sanitizeEnvValue = (value) => String(value).replace(/[\r\n]+/g, "");

    for (const key of PLAIN_ENV_KEYS) {
      if (process.env[key]) content += `${key}=${sanitizeEnvValue(process.env[key])}\n`;
    }

    // Fallback: if encryption is unavailable, include secrets in the plain file
    // so that API keys survive restarts even without OS-keychain support.
    if (!this._encryptionAvailable) {
      for (const key of SECRET_ENV_KEYS) {
        if (process.env[key]) content += `${key}=${sanitizeEnvValue(process.env[key])}\n`;
      }
    }

    try {
      fs.writeFileSync(this._plainEnvPath, content, "utf8");
      this._restrictEnvFilePermissions(this._plainEnvPath);
    } catch (err) {
      console.error("Failed to persist plain env file:", err.message);
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Internal helpers
  // ──────────────────────────────────────────────────────────────────────────

  _getKey(envVarName) {
    return process.env[envVarName] || "";
  }

  _saveKey(envVarName, key) {
    process.env[envVarName] = key;
    if (SECRET_ENV_KEYS.has(envVarName)) {
      this._persistEncryptedStore();
      // Also update the plain file so non-encryption fallback stays current.
      if (!this._encryptionAvailable) this._persistPlainEnvFile();
    }
    return { success: true };
  }

  /**
   * Restricts the .env file to owner read/write only (Unix mode 0o600).
   * Skipped on Windows because NTFS permissions work differently; the userData
   * directory itself provides sufficient isolation there.
   */
  _restrictEnvFilePermissions(filePath) {
    if (process.platform === "win32") return;
    try {
      fs.chmodSync(filePath, 0o600);
    } catch {
      // Non-fatal — best-effort on networked / virtual filesystems.
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Public API — mirrors the old interface exactly so no callers change
  // ──────────────────────────────────────────────────────────────────────────

  getOpenAIKey() {
    return this._getKey("OPENAI_API_KEY");
  }
  saveOpenAIKey(key) {
    return this._saveKey("OPENAI_API_KEY", key);
  }

  getAnthropicKey() {
    return this._getKey("ANTHROPIC_API_KEY");
  }
  saveAnthropicKey(key) {
    return this._saveKey("ANTHROPIC_API_KEY", key);
  }

  getGeminiKey() {
    return this._getKey("GEMINI_API_KEY");
  }
  saveGeminiKey(key) {
    return this._saveKey("GEMINI_API_KEY", key);
  }

  getGroqKey() {
    return this._getKey("GROQ_API_KEY");
  }
  saveGroqKey(key) {
    return this._saveKey("GROQ_API_KEY", key);
  }

  getCustomTranscriptionKey() {
    return this._getKey("CUSTOM_TRANSCRIPTION_API_KEY");
  }
  saveCustomTranscriptionKey(key) {
    return this._saveKey("CUSTOM_TRANSCRIPTION_API_KEY", key);
  }

  getCustomReasoningKey() {
    return this._getKey("CUSTOM_REASONING_API_KEY");
  }
  saveCustomReasoningKey(key) {
    return this._saveKey("CUSTOM_REASONING_API_KEY", key);
  }

  getDictationKey() {
    return this._getKey("DICTATION_KEY");
  }
  saveDictationKey(key) {
    return this._saveKey("DICTATION_KEY", key);
  }

  /**
   * Persist all current keys.  Called by IPC handlers that bulk-save settings.
   * Replaces the old saveAllKeysToEnvFile().
   */
  saveAllKeysToEnvFile() {
    this._persistEncryptedStore();
    this._persistPlainEnvFile();
    return { success: true, path: this._plainEnvPath };
  }

  /**
   * Legacy helper used during first-run onboarding.  Creates the env file and
   * stores the first OpenAI key.
   */
  createProductionEnvFile(apiKey) {
    this._saveKey("OPENAI_API_KEY", apiKey);
    this._persistPlainEnvFile();
    return { success: true, path: this._plainEnvPath };
  }
}

module.exports = EnvironmentManager;
