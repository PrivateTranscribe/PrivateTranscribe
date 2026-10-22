/**
 * A key store that cannot be read is left on disk, not replaced.
 * @module tests/unit/helpers/environmentUnreadableStore
 *
 * Every window's startup sync rewrites the stores a few seconds after launch.
 * When keys.enc could not be read (a write cut short by a power loss, or the
 * Windows key it is encrypted with being unavailable for that start), that
 * rewrite replaced every saved API key with an empty store.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const EnvironmentManager = require("../../../src/helpers/environment");

let userDataDir = "";
let decryptShouldThrow = false;

const runtime = () => ({
  app: { getPath: () => userDataDir },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plain: string) => Buffer.from(`enc:${plain}`, "utf8"),
    decryptString: (buf: Buffer) => {
      if (decryptShouldThrow) throw new Error("Error while decrypting the ciphertext");
      return buf.toString("utf8").slice(4);
    },
  },
});

const storePath = () => path.join(userDataDir, "keys.enc");
const asideFiles = () =>
  fs.readdirSync(userDataDir).filter((name) => name.startsWith("keys.enc.unreadable"));

describe("EnvironmentManager with an unreadable key store", () => {
  beforeEach(() => {
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-keys-"));
    decryptShouldThrow = false;
    delete process.env.OPENAI_API_KEY;
    delete process.env.GROQ_API_KEY;
    new EnvironmentManager(runtime()).saveOpenAIKey("sk-test-only-saved");
  });

  afterEach(() => {
    fs.rmSync(userDataDir, { recursive: true, force: true });
    delete process.env.OPENAI_API_KEY;
    delete process.env.GROQ_API_KEY;
  });

  it("leaves the store untouched when the startup sync rewrites the settings", () => {
    const before = fs.readFileSync(storePath());
    decryptShouldThrow = true;

    new EnvironmentManager(runtime()).saveAllKeysToEnvFile();

    expect(fs.readFileSync(storePath())).toEqual(before);
  });

  it("reads the keys again at the next start once decryption works", () => {
    decryptShouldThrow = true;
    new EnvironmentManager(runtime()).saveAllKeysToEnvFile();
    decryptShouldThrow = false;

    expect(new EnvironmentManager(runtime()).getOpenAIKey()).toBe("sk-test-only-saved");
  });

  it("keeps the unreadable store beside the new one when a key is saved", () => {
    const before = fs.readFileSync(storePath());
    decryptShouldThrow = true;

    new EnvironmentManager(runtime()).saveGroqKey("gsk-test-only-new");

    const aside = asideFiles();
    expect(aside).toHaveLength(1);
    expect(fs.readFileSync(path.join(userDataDir, aside[0]))).toEqual(before);
    decryptShouldThrow = false;
    expect(new EnvironmentManager(runtime()).getGroqKey()).toBe("gsk-test-only-new");
  });

  it("writes a readable store as before", () => {
    const manager = new EnvironmentManager(runtime());
    manager.saveGroqKey("gsk-test-only-new");

    const reloaded = new EnvironmentManager(runtime());
    expect(reloaded.getOpenAIKey()).toBe("sk-test-only-saved");
    expect(reloaded.getGroqKey()).toBe("gsk-test-only-new");
    expect(asideFiles()).toEqual([]);
  });
});
