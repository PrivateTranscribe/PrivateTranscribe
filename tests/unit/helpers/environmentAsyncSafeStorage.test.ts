/**
 * The key store runs on Electron's async safeStorage API.
 * @module tests/unit/helpers/environmentAsyncSafeStorage
 *
 * Electron 45 deprecated isEncryptionAvailable, encryptString and
 * decryptString, and Electron 46 removes them. Every user's keys.enc was
 * written by the old encryptString, so it must still load through
 * decryptStringAsync, which Electron documents as able to read it.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const EnvironmentManager = require("../../../src/helpers/environment");

let userDataDir = "";
/** Whether decryption reports that the OS key has changed since the write. */
let reportReEncrypt = false;
/** Milliseconds each encryptStringAsync call waits, in call order. */
let encryptDelays: number[] = [];

// Stand-in for the OS keychain. Old and new data both start "v1:", as the
// docs say both APIs share one key store; "v2:" is a rotated key.
const legacyEncryptString = (plain: string) => Buffer.from(`v1:${plain}`, "utf8");

const syncRemoved = () => {
  throw new Error("The synchronous safeStorage API is removed in Electron 46");
};

const runtime = () => ({
  app: { getPath: () => userDataDir },
  safeStorage: {
    isEncryptionAvailable: syncRemoved,
    encryptString: syncRemoved,
    decryptString: syncRemoved,
    isAsyncEncryptionAvailable: async () => true,
    encryptStringAsync: async (plain: string) => {
      const delay = encryptDelays.shift() ?? 0;
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      return Buffer.from(`${reportReEncrypt ? "v2" : "v1"}:${plain}`, "utf8");
    },
    decryptStringAsync: async (buf: Buffer) => {
      const raw = buf.toString("utf8");
      if (!/^v[12]:/.test(raw)) throw new Error("Error while decrypting the ciphertext");
      return { shouldReEncrypt: reportReEncrypt && raw.startsWith("v1:"), result: raw.slice(3) };
    },
  },
});

const storePath = () => path.join(userDataDir, "keys.enc");
const readStore = () => fs.readFileSync(storePath(), "utf8");

describe("EnvironmentManager on the async safeStorage API", () => {
  beforeEach(() => {
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-async-keys-"));
    fs.writeFileSync(path.join(userDataDir, ".env"), "");
    reportReEncrypt = false;
    encryptDelays = [];
    delete process.env.OPENAI_API_KEY;
    delete process.env.GROQ_API_KEY;
    // keys.enc exactly as the sync-API builds wrote it.
    fs.writeFileSync(
      storePath(),
      legacyEncryptString(JSON.stringify({ OPENAI_API_KEY: "sk-test-only-sync-written" }))
    );
  });

  afterEach(() => {
    fs.rmSync(userDataDir, { recursive: true, force: true });
    delete process.env.OPENAI_API_KEY;
    delete process.env.GROQ_API_KEY;
  });

  it("loads a keys.enc the old encryptString wrote, without the sync API", async () => {
    const manager = new EnvironmentManager(runtime());

    expect(await manager.getOpenAIKey()).toBe("sk-test-only-sync-written");
  });

  it("keeps the sync-written key when a second key is saved", async () => {
    await new EnvironmentManager(runtime()).saveGroqKey("gsk-test-only-new");

    const reloaded = new EnvironmentManager(runtime());
    expect(await reloaded.getOpenAIKey()).toBe("sk-test-only-sync-written");
    expect(await reloaded.getGroqKey()).toBe("gsk-test-only-new");
  });

  it("writes the store again under the new OS key when asked to re-encrypt", async () => {
    reportReEncrypt = true;

    await new EnvironmentManager(runtime()).ready;

    expect(readStore()).toBe(
      `v2:${JSON.stringify({ OPENAI_API_KEY: "sk-test-only-sync-written" })}`
    );
  });

  it("leaves the store as it is when no re-encryption is asked for", async () => {
    const before = fs.readFileSync(storePath());

    await new EnvironmentManager(runtime()).ready;

    expect(fs.readFileSync(storePath())).toEqual(before);
  });

  it("keeps both keys when two saves overlap and the first encrypts slower", async () => {
    const manager = new EnvironmentManager(runtime());
    await manager.ready;
    encryptDelays = [40, 0];

    await Promise.all([
      manager.saveGroqKey("gsk-test-only-first"),
      manager.saveOpenAIKey("sk-test-only-second"),
    ]);

    expect(JSON.parse(readStore().slice(3))).toEqual({
      OPENAI_API_KEY: "sk-test-only-second",
      GROQ_API_KEY: "gsk-test-only-first",
    });
  });

  it("treats a failed availability check as no encryption, and keeps keys.enc", async () => {
    const before = fs.readFileSync(storePath());
    const broken = runtime();
    broken.safeStorage.isAsyncEncryptionAvailable = async () => {
      throw new Error("keychain unreachable");
    };

    const manager = new EnvironmentManager(broken);
    await manager.saveAllKeysToEnvFile();

    expect(await manager.getOpenAIKey()).toBe("");
    expect(fs.readFileSync(storePath())).toEqual(before);
  });
});
