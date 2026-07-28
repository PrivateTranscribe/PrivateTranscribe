/**
 * Tests for clear-text secret migration in EnvironmentManager.
 * @module tests/unit/helpers/environmentSecretMigration
 *
 * Builds before the encrypted store existed - and any run on a machine with no
 * keyring - wrote API keys to userData/.env in clear text. Once encryption is
 * available those keys must be moved into the encrypted store and removed from
 * the plain file, without ever losing them.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

let userDataDir = "";
let encryptionAvailable = true;
let encryptShouldThrow = false;

function makeRuntime() {
  return {
    app: { getPath: () => userDataDir },
    safeStorage: {
      isEncryptionAvailable: () => encryptionAvailable,
      // Reversible stand-in for the OS keychain.
      encryptString: (plain: string) => {
        if (encryptShouldThrow) throw new Error("keychain unavailable");
        return Buffer.from(`enc:${plain}`, "utf8");
      },
      decryptString: (buf: Buffer) => {
        const raw = buf.toString("utf8");
        if (!raw.startsWith("enc:")) throw new Error("bad ciphertext");
        return raw.slice(4);
      },
    },
  };
}

async function loadManager() {
  const mod = await import("../../../src/helpers/environment.js");
  return (mod.default ?? mod) as new (runtime: unknown) => unknown;
}

const SECRET_KEYS = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GROQ_API_KEY"];

function envPath() {
  return path.join(userDataDir, ".env");
}
function storePath() {
  return path.join(userDataDir, "keys.enc");
}

describe("EnvironmentManager clear-text secret migration", () => {
  beforeEach(() => {
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-env-"));
    encryptionAvailable = true;
    encryptShouldThrow = false;
    for (const key of SECRET_KEYS) delete process.env[key];
    delete process.env.REASONING_PROVIDER;
  });

  afterEach(() => {
    fs.rmSync(userDataDir, { recursive: true, force: true });
    for (const key of SECRET_KEYS) delete process.env[key];
    delete process.env.REASONING_PROVIDER;
  });

  it("moves legacy clear-text keys into the encrypted store and scrubs the file", async () => {
    fs.writeFileSync(
      envPath(),
      "REASONING_PROVIDER=openai\nOPENAI_API_KEY=sk-legacy-secret\n",
      "utf8"
    );

    const EnvironmentManager = await loadManager();
    new EnvironmentManager(makeRuntime());

    // Key still usable in this process.
    expect(process.env.OPENAI_API_KEY).toBe("sk-legacy-secret");

    // No longer sitting in clear text.
    const plain = fs.readFileSync(envPath(), "utf8");
    expect(plain).not.toContain("sk-legacy-secret");
    expect(plain).not.toContain("OPENAI_API_KEY");

    // Non-secret settings survive the rewrite.
    expect(plain).toContain("REASONING_PROVIDER=openai");

    // And it is recoverable from the encrypted store.
    expect(fs.existsSync(storePath())).toBe(true);
    expect(fs.readFileSync(storePath(), "utf8")).toContain("sk-legacy-secret");
  });

  it("keeps the clear-text key when encryption fails, rather than losing it", async () => {
    fs.writeFileSync(envPath(), "OPENAI_API_KEY=sk-legacy-secret\n", "utf8");
    encryptShouldThrow = true;

    const EnvironmentManager = await loadManager();
    new EnvironmentManager(makeRuntime());

    // Migration must not scrub what it could not encrypt.
    expect(fs.readFileSync(envPath(), "utf8")).toContain("sk-legacy-secret");
    expect(process.env.OPENAI_API_KEY).toBe("sk-legacy-secret");
  });

  it("leaves the plain file alone when it holds no secrets", async () => {
    const original = "REASONING_PROVIDER=openai\n";
    fs.writeFileSync(envPath(), original, "utf8");

    const EnvironmentManager = await loadManager();
    new EnvironmentManager(makeRuntime());

    expect(fs.readFileSync(envPath(), "utf8")).toBe(original);
  });

  it("does not scrub secrets when there is no keyring to migrate them into", async () => {
    fs.writeFileSync(envPath(), "OPENAI_API_KEY=sk-legacy-secret\n", "utf8");
    encryptionAvailable = false;

    const EnvironmentManager = await loadManager();
    new EnvironmentManager(makeRuntime());

    // Without encryption the plain file is the only store available.
    expect(fs.readFileSync(envPath(), "utf8")).toContain("sk-legacy-secret");
  });

  it("migrates every secret key that was left in clear text", async () => {
    fs.writeFileSync(
      envPath(),
      "OPENAI_API_KEY=sk-a\nANTHROPIC_API_KEY=sk-b\nGROQ_API_KEY=sk-c\n",
      "utf8"
    );

    const EnvironmentManager = await loadManager();
    new EnvironmentManager(makeRuntime());

    const plain = fs.readFileSync(envPath(), "utf8");
    for (const value of ["sk-a", "sk-b", "sk-c"]) {
      expect(plain).not.toContain(value);
      expect(fs.readFileSync(storePath(), "utf8")).toContain(value);
    }
  });
});
