/**
 * Tests for how EnvironmentManager rewrites the plain userData/.env file.
 * @module tests/unit/helpers/environmentPlainEnvFile
 *
 * DEBUG.md and WINDOWS_TROUBLESHOOTING.md tell users to add PT_LOG_LEVEL and the
 * PRIVOCA_DISABLE_* privacy switches to this file by hand. The app owns only its
 * own keys, so a rewrite must keep every other line.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const HEADER =
  "# PrivateTranscribe settings. The app rewrites its own keys and keeps every other line.";

// What builds before this change wrote at the top of the file.
const OLD_HEADER =
  "# PrivateTranscribe — non-secret settings\n# Generated automatically — do not edit manually.\n";

// dotenv never overrides a key that is already set, so every key a test can put
// in process.env is unset before and after each test.
const TOUCHED_KEYS = [
  "LOCAL_TRANSCRIPTION_PROVIDER",
  "WHISPER_FORCE_CPU",
  "PARAKEET_MODEL",
  "LOCAL_WHISPER_MODEL",
  "REASONING_PROVIDER",
  "LOCAL_REASONING_MODEL",
  "DICTATION_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GEMINI_API_KEY",
  "GROQ_API_KEY",
  "CUSTOM_TRANSCRIPTION_API_KEY",
  "CUSTOM_REASONING_API_KEY",
  "PT_LOG_LEVEL",
  "PRIVOCA_DISABLE_CONTEXT_CAPTURE",
  "PRIVOCA_DISABLE_WINDOWS_UIA",
  "DICTATION_KEY_OLD",
];

type Manager = { saveAllKeysToEnvFile: () => unknown };

let userDataDir = "";
let encryptionAvailable = true;

function makeRuntime() {
  return {
    app: { getPath: () => userDataDir },
    safeStorage: {
      isEncryptionAvailable: () => encryptionAvailable,
      // Reversible stand-in for the OS keychain.
      encryptString: (plain: string) => Buffer.from(`enc:${plain}`, "utf8"),
      decryptString: (buf: Buffer) => buf.toString("utf8").slice(4),
    },
  };
}

async function createManager(): Promise<Manager> {
  const mod = await import("../../../src/helpers/environment.js");
  const EnvironmentManager = (mod.default ?? mod) as new (runtime: unknown) => Manager;
  return new EnvironmentManager(makeRuntime());
}

function envPath() {
  return path.join(userDataDir, ".env");
}
function storePath() {
  return path.join(userDataDir, "keys.enc");
}
function writeEnvFile(contents: string) {
  fs.writeFileSync(envPath(), contents, "utf8");
}
function readEnvFile() {
  return fs.readFileSync(envPath(), "utf8");
}
// The whole file the app should write: its header, then these lines, LF endings.
function expectedFile(...lines: string[]) {
  return [HEADER, ...lines].join("\n") + "\n";
}
function clearTouchedKeys() {
  for (const key of TOUCHED_KEYS) delete process.env[key];
}

describe("EnvironmentManager plain .env rewrite", () => {
  beforeEach(() => {
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-env-"));
    encryptionAvailable = true;
    clearTouchedKeys();
  });

  afterEach(() => {
    fs.rmSync(userDataDir, { recursive: true, force: true });
    clearTouchedKeys();
  });

  it("keeps the guides' debug and privacy lines, with their comments, when a setting changes", async () => {
    writeEnvFile(
      OLD_HEADER +
        [
          "REASONING_PROVIDER=openai",
          "",
          "# Disable ALL active-window context capture (window title + UIA)",
          "PRIVOCA_DISABLE_CONTEXT_CAPTURE=true",
          "",
          "# Disable Windows UI Automation (focused element text) capture",
          "PRIVOCA_DISABLE_WINDOWS_UIA=true",
          "PT_LOG_LEVEL=debug",
          "",
        ].join("\n")
    );
    const manager = await createManager();

    process.env.DICTATION_KEY = "F9";
    manager.saveAllKeysToEnvFile();

    expect(readEnvFile()).toBe(
      expectedFile(
        "REASONING_PROVIDER=openai",
        "DICTATION_KEY=F9",
        "",
        "# Disable ALL active-window context capture (window title + UIA)",
        "PRIVOCA_DISABLE_CONTEXT_CAPTURE=true",
        "",
        "# Disable Windows UI Automation (focused element text) capture",
        "PRIVOCA_DISABLE_WINDOWS_UIA=true",
        "PT_LOG_LEVEL=debug"
      )
    );
  });

  it("replaces a managed key's line in each form dotenv reads, never duplicating it", async () => {
    writeEnvFile(
      [
        "  DICTATION_KEY = F8",
        "export REASONING_PROVIDER=openai",
        "LOCAL_WHISPER_MODEL: base",
        "DICTATION_KEY_OLD=F8",
        "",
      ].join("\n")
    );
    const manager = await createManager();
    // dotenv reads each of these forms as an assignment.
    expect([
      process.env.DICTATION_KEY,
      process.env.REASONING_PROVIDER,
      process.env.LOCAL_WHISPER_MODEL,
    ]).toEqual(["F8", "openai", "base"]);

    process.env.DICTATION_KEY = "F9";
    process.env.REASONING_PROVIDER = "anthropic";
    process.env.LOCAL_WHISPER_MODEL = "small";
    manager.saveAllKeysToEnvFile();

    expect(readEnvFile()).toBe(
      expectedFile(
        "LOCAL_WHISPER_MODEL=small",
        "REASONING_PROVIDER=anthropic",
        "DICTATION_KEY=F9",
        "",
        "DICTATION_KEY_OLD=F8"
      )
    );
  });

  it("drops a managed key's line once the setting is cleared", async () => {
    writeEnvFile(
      "LOCAL_TRANSCRIPTION_PROVIDER=nvidia\nPARAKEET_MODEL=parakeet-tdt-0.6b-v3\nPT_LOG_LEVEL=debug\n"
    );
    const manager = await createManager();

    // What stopping the Parakeet server does.
    delete process.env.LOCAL_TRANSCRIPTION_PROVIDER;
    delete process.env.PARAKEET_MODEL;
    manager.saveAllKeysToEnvFile();

    expect(readEnvFile()).toBe(expectedFile("", "PT_LOG_LEVEL=debug"));
  });

  it("scrubs a clear-text secret at boot and keeps the hand-added line beside it", async () => {
    writeEnvFile("OPENAI_API_KEY=sk-legacy-secret\nPRIVOCA_DISABLE_CONTEXT_CAPTURE=true\n");

    await createManager();

    expect(readEnvFile()).not.toContain("sk-legacy-secret");
    expect(readEnvFile()).toBe(expectedFile("", "PRIVOCA_DISABLE_CONTEXT_CAPTURE=true"));
    expect(fs.readFileSync(storePath(), "utf8")).toContain("sk-legacy-secret");
  });

  it("never keeps a secret-key line on save while encryption is available", async () => {
    writeEnvFile("export OPENAI_API_KEY=sk-legacy-secret\nPT_LOG_LEVEL=debug\n");
    const manager = await createManager();

    manager.saveAllKeysToEnvFile();

    expect(readEnvFile()).toBe(expectedFile("", "PT_LOG_LEVEL=debug"));
    expect(fs.readFileSync(storePath(), "utf8")).toContain("sk-legacy-secret");
  });

  it("writes a secret once, from process.env, when encryption is unavailable", async () => {
    encryptionAvailable = false;
    writeEnvFile("PT_LOG_LEVEL=debug\nOPENAI_API_KEY=sk-legacy-secret\n");
    const manager = await createManager();

    manager.saveAllKeysToEnvFile();

    expect(readEnvFile()).toBe(
      expectedFile("OPENAI_API_KEY=sk-legacy-secret", "", "PT_LOG_LEVEL=debug")
    );
  });

  it("gives byte-identical files on two rewrites in a row", async () => {
    writeEnvFile(
      OLD_HEADER +
        [
          "REASONING_PROVIDER=openai",
          "",
          "# Disable ALL active-window context capture (window title + UIA)",
          "PRIVOCA_DISABLE_CONTEXT_CAPTURE=true",
          "DICTATION_KEY=F8",
          "",
          "PT_LOG_LEVEL=debug",
          "",
          "",
        ].join("\n")
    );
    const manager = await createManager();

    manager.saveAllKeysToEnvFile();
    const first = readEnvFile();
    manager.saveAllKeysToEnvFile();

    expect(readEnvFile()).toBe(first);
    expect(first).toBe(
      expectedFile(
        "REASONING_PROVIDER=openai",
        "DICTATION_KEY=F8",
        "",
        "# Disable ALL active-window context capture (window title + UIA)",
        "PRIVOCA_DISABLE_CONTEXT_CAPTURE=true",
        "",
        "PT_LOG_LEVEL=debug"
      )
    );
  });

  it("reads CRLF and a BOM, writes plain LF lines, and the kept keys still load", async () => {
    writeEnvFile(
      "\uFEFFPT_LOG_LEVEL=debug\r\n\r\nDICTATION_KEY=F8\r\nPRIVOCA_DISABLE_WINDOWS_UIA=true\r\n"
    );
    const manager = await createManager();

    manager.saveAllKeysToEnvFile();

    const plain = readEnvFile();
    expect(plain).not.toContain("\r");
    expect(plain).not.toContain("\uFEFF");
    expect(plain).toBe(
      expectedFile(
        "DICTATION_KEY=F8",
        "",
        "PT_LOG_LEVEL=debug",
        "",
        "PRIVOCA_DISABLE_WINDOWS_UIA=true"
      )
    );

    clearTouchedKeys();
    await createManager();

    expect(process.env.PT_LOG_LEVEL).toBe("debug");
    expect(process.env.PRIVOCA_DISABLE_WINDOWS_UIA).toBe("true");
  });

  it("drops the header lines older builds wrote", async () => {
    writeEnvFile(
      "# Privoca Environment Variables\n# This file was created automatically for production use\nREASONING_PROVIDER=openai\nPT_LOG_LEVEL=debug\n"
    );
    const manager = await createManager();

    manager.saveAllKeysToEnvFile();

    expect(readEnvFile()).toBe(expectedFile("REASONING_PROVIDER=openai", "", "PT_LOG_LEVEL=debug"));
  });

  it("writes only its own keys when the file is missing at save time", async () => {
    writeEnvFile("REASONING_PROVIDER=openai\n");
    const manager = await createManager();
    fs.rmSync(envPath());

    manager.saveAllKeysToEnvFile();

    expect(readEnvFile()).toBe(expectedFile("REASONING_PROVIDER=openai"));
  });

  it("never copies debug or privacy switches from process.env into the file", async () => {
    // A development run shares this userData folder with the installed app.
    process.env.PT_LOG_LEVEL = "debug";
    process.env.PRIVOCA_DISABLE_CONTEXT_CAPTURE = "true";
    writeEnvFile("REASONING_PROVIDER=openai\n");
    const manager = await createManager();

    manager.saveAllKeysToEnvFile();

    expect(readEnvFile()).toBe(expectedFile("REASONING_PROVIDER=openai"));
  });
});
