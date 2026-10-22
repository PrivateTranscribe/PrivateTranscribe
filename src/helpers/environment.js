const path = require("path");
const fs = require("fs");

/**
 * API keys that contain secrets and must be stored encrypted.
 * Everything else (provider selection, model names, hotkeys) is non-sensitive
 * and continues to live in a plain .env file.
 *
 * A saved key lives in the manager's memory, never in process.env: every child
 * process inherits process.env, and Converse runs the user's own Claude Code,
 * whose commands would read it there. process.env keeps the user's own values
 * as the app was started with them, which the getters fall back to.
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
  "WHISPER_FORCE_CPU",
  "PARAKEET_MODEL",
  "LOCAL_WHISPER_MODEL",
  "REASONING_PROVIDER",
  "LOCAL_REASONING_MODEL",
  "DICTATION_KEY",
];

class EnvironmentManager {
  /**
   * @param {{ app: Electron.App, safeStorage: Electron.SafeStorage }} [runtime]
   *   Electron services, injectable so this class can be unit-tested without a
   *   live Electron runtime. Production callers use the default.
   */
  constructor(runtime = require("electron")) {
    const { app, safeStorage } = runtime;
    this._safeStorage = safeStorage;
    this._encryptedStorePath = path.join(app.getPath("userData"), "keys.enc");
    this._plainEnvPath = path.join(app.getPath("userData"), ".env");
    this._encryptionAvailable = safeStorage.isEncryptionAvailable();
    /** The keys saved in the app, by SECRET_ENV_KEYS name. */
    this._secrets = new Map();
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
      // 3. Sweep up secrets left in clear text by an older build or by a run
      //    that had no keyring available.
      this._migratePlainEnvSecrets();
    } else {
      // Encryption unavailable (e.g. headless Linux without a keyring).
      // Plain .env already loaded above; nothing more to do.
    }
  }

  /**
   * Move any clear-text secrets sitting in our own .env into the encrypted
   * store, then rewrite the file without them.
   *
   * Builds before the encrypted store existed — and any run on a machine with
   * no keyring — wrote API keys to userData/.env in clear text. Once encryption
   * is available those keys would otherwise sit on disk unprotected forever,
   * because the normal save path only ever appends to the encrypted store.
   *
   * Only the app-owned file in userData is touched. The development and
   * resourcesPath .env candidates are the developer's or the installer's files,
   * so they are left alone.
   */
  _migratePlainEnvSecrets() {
    let contents;
    try {
      if (!fs.existsSync(this._plainEnvPath)) return;
      contents = fs.readFileSync(this._plainEnvPath, "utf8");
    } catch {
      return;
    }

    const hasPlainSecret = [...SECRET_ENV_KEYS].some((key) =>
      new RegExp(`^\\s*${key}\\s*=`, "m").test(contents)
    );
    if (!hasPlainSecret) return;

    // Only rewrite the plain file once the secrets are safely encrypted,
    // otherwise a failed write here would discard the user's keys.
    if (!this._persistEncryptedStore()) return;
    this._persistPlainEnvFile();
  }

  /**
   * Attempt to load the encrypted key store into the saved keys.
   * Silently ignores a missing file (first run) or a corrupt file (returns
   * early so the keys from the .env fallback stand).
   */
  _loadEncryptedStore() {
    try {
      if (!fs.existsSync(this._encryptedStorePath)) return;
      const cipherBuf = fs.readFileSync(this._encryptedStorePath);
      const jsonStr = this._safeStorage.decryptString(cipherBuf);
      const parsed = JSON.parse(jsonStr);
      if (parsed && typeof parsed === "object") {
        for (const [key, value] of Object.entries(parsed)) {
          if (SECRET_ENV_KEYS.has(key) && typeof value === "string") {
            this._secrets.set(key, value);
          }
        }
      }
    } catch (err) {
      // Corrupt file or decryption failure — keep whatever plain-env loaded.
      // The file may only be unreadable for this start, so it must survive
      // the settings rewrite every window sends a few seconds after launch.
      this._encryptedStoreUnreadable = true;
      console.warn("Could not read the encrypted key store:", err.message);
    }
  }

  /**
   * A store this start could not read is never written over. With no key to
   * save it is left as it is, so the next start can try it again. Once a key
   * is saved, the old file is moved aside first, so its keys can still be
   * recovered.
   */
  _keepUnreadableEncryptedStore() {
    if (!this._encryptedStoreUnreadable) return true;
    if (this._secrets.size === 0) return false;
    try {
      fs.renameSync(
        this._encryptedStorePath,
        `${this._encryptedStorePath}.unreadable-${Date.now()}`
      );
    } catch (err) {
      if (err.code !== "ENOENT") {
        console.error("Failed to move the unreadable key store aside:", err.message);
        return false;
      }
    }
    this._encryptedStoreUnreadable = false;
    return true;
  }

  /**
   * Write the saved keys to the encrypted store. A key the user set in their
   * own environment is not one of them, so it is never copied in.
   * Called after every key save to keep the store in sync.
   */
  _persistEncryptedStore() {
    if (!this._encryptionAvailable) return false;
    const secrets = {};
    for (const [key, value] of this._secrets) {
      if (value) secrets[key] = value;
    }
    if (!this._keepUnreadableEncryptedStore()) return false;
    try {
      const cipherBuf = this._safeStorage.encryptString(JSON.stringify(secrets));
      fs.writeFileSync(this._encryptedStorePath, cipherBuf);
      return true;
    } catch (err) {
      // Non-fatal: in-memory value already set; worst case the key is gone on
      // next restart and the user re-enters it.
      console.error("Failed to persist encrypted key store:", err.message);
      return false;
    }
  }

  /**
   * Load the plain .env file.  Tries the userData path first; on first run the
   * file won't exist there, so falls back to legacy development/resource paths.
   * dotenv never replaces a variable that is already set, so a key the user set
   * themselves wins over the file, as before. A key the file adds becomes a
   * saved key and leaves process.env again.
   */
  _loadPlainEnvFile() {
    const ownKeys = [...SECRET_ENV_KEYS].filter((key) => process.env[key] !== undefined);
    this._readPlainEnvCandidates();
    for (const key of SECRET_ENV_KEYS) {
      if (ownKeys.includes(key) || process.env[key] === undefined) continue;
      this._secrets.set(key, process.env[key]);
      delete process.env[key];
    }
  }

  _readPlainEnvCandidates() {
    const candidates = [
      this._plainEnvPath,
      // Development
      path.join(__dirname, "..", ".env"),
      // Production legacy paths. resourcesPath only exists in a packaged app,
      // so skip them rather than throwing when it is undefined.
      ...(process.resourcesPath
        ? [
            path.join(process.resourcesPath, ".env"),
            path.join(process.resourcesPath, "app.asar.unpacked", ".env"),
            path.join(process.resourcesPath, "app", ".env"),
          ]
        : []),
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
   * Every line it does not manage is kept: the user guides tell people to add
   * debug and privacy switches here by hand. Managing those keys instead would
   * copy a dev run's process.env into the installed app, which shares this file.
   */
  _persistPlainEnvFile() {
    const header =
      "# PrivateTranscribe settings. The app rewrites its own keys and keeps every other line.";
    const sanitizeEnvValue = (value) => String(value).replace(/[\r\n]+/g, "");
    const lines = [header];

    for (const key of PLAIN_ENV_KEYS) {
      if (process.env[key]) lines.push(`${key}=${sanitizeEnvValue(process.env[key])}`);
    }

    // Fallback: if encryption is unavailable, include secrets in the plain file
    // so that API keys survive restarts even without OS-keychain support.
    if (!this._encryptionAvailable) {
      for (const key of SECRET_ENV_KEYS) {
        const value = this._secrets.get(key);
        if (value) lines.push(`${key}=${sanitizeEnvValue(value)}`);
      }
    }

    const kept = this._readUnmanagedPlainEnvLines(header);
    if (kept.length > 0) lines.push("", ...kept);

    try {
      fs.writeFileSync(this._plainEnvPath, `${lines.join("\n")}\n`, "utf8");
      this._restrictEnvFilePermissions(this._plainEnvPath);
    } catch (err) {
      console.error("Failed to persist plain env file:", err.message);
    }
  }

  _readUnmanagedPlainEnvLines(header) {
    let contents;
    try {
      contents = fs.readFileSync(this._plainEnvPath, "utf8");
    } catch {
      return [];
    }
    const appHeaders = new Set([
      header,
      "# PrivateTranscribe — non-secret settings",
      "# Generated automatically — do not edit manually.",
      "# PrivateTranscribe Environment Variables",
      "# Privoca Environment Variables",
      "# DictateVoice Environment Variables",
      "# This file was created automatically for production use",
    ]);
    const dotenvAssignment = /^\s*(?:export\s+)?([\w.-]+)(?:\s*=|:\s)/;
    const kept = contents
      .replace(/^\uFEFF/, "")
      .split(/\r\n?|\n/)
      .filter((line) => {
        const key = dotenvAssignment.exec(line)?.[1];
        const managed = PLAIN_ENV_KEYS.includes(key) || SECRET_ENV_KEYS.has(key);
        return !managed && !appHeaders.has(line.trim());
      });
    while (kept.length > 0 && !kept[0].trim()) kept.shift();
    while (kept.length > 0 && !kept[kept.length - 1].trim()) kept.pop();
    return kept;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Internal helpers
  // ──────────────────────────────────────────────────────────────────────────

  /** A saved key, else the user's own variable of that name. */
  _getKey(envVarName) {
    if (this._secrets.has(envVarName)) return this._secrets.get(envVarName) || "";
    return process.env[envVarName] || "";
  }

  _saveKey(envVarName, key) {
    if (SECRET_ENV_KEYS.has(envVarName)) {
      this._secrets.set(envVarName, key);
      this._persistEncryptedStore();
      // Also update the plain file so non-encryption fallback stays current.
      if (!this._encryptionAvailable) this._persistPlainEnvFile();
    } else {
      process.env[envVarName] = key;
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
