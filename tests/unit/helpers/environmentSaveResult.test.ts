/**
 * Saving an API key reports whether it reached the disk.
 * @module tests/unit/helpers/environmentSaveResult
 *
 * A save always reported success, so a key whose keys.enc write failed worked
 * until the app closed and was then gone with no clue why. The settings screen
 * now shows "Could not save the key" when a save reports failure.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const EnvironmentManager = require("../../../src/helpers/environment");

let userDataDir = "";
let encryptionAvailable = true;
let decryptShouldThrow = false;

const runtime = () => ({
  app: { getPath: () => userDataDir },
  safeStorage: {
    isAsyncEncryptionAvailable: async () => encryptionAvailable,
    encryptStringAsync: async (plain: string) => Buffer.from(`enc:${plain}`, "utf8"),
    decryptStringAsync: async (buf: Buffer) => {
      if (decryptShouldThrow) throw new Error("Error while decrypting the ciphertext");
      return { shouldReEncrypt: false, result: buf.toString("utf8").slice(4) };
    },
  },
});

const storePath = () => path.join(userDataDir, "keys.enc");
const plainPath = () => path.join(userDataDir, ".env");
const NOT_SAVED = { success: false, error: "key-not-written" };

describe("EnvironmentManager key save result", () => {
  beforeEach(() => {
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-save-result-"));
    fs.writeFileSync(plainPath(), "");
    encryptionAvailable = true;
    decryptShouldThrow = false;
    delete process.env.OPENAI_API_KEY;
    delete process.env.GROQ_API_KEY;
  });

  afterEach(() => {
    if (fs.existsSync(storePath())) fs.chmodSync(storePath(), 0o666);
    fs.rmSync(userDataDir, { recursive: true, force: true });
    delete process.env.OPENAI_API_KEY;
    delete process.env.GROQ_API_KEY;
  });

  it("reports success once the key is in keys.enc", async () => {
    const manager = new EnvironmentManager(runtime());

    expect(await manager.saveOpenAIKey("sk-test-only-saved")).toEqual({ success: true });
    expect(fs.readFileSync(storePath(), "utf8")).toContain("sk-test-only-saved");
  });

  it("reports failure when keys.enc cannot be written, and keeps the key for this run", async () => {
    await new EnvironmentManager(runtime()).saveOpenAIKey("sk-test-only-before");
    fs.chmodSync(storePath(), 0o444);
    const manager = new EnvironmentManager(runtime());

    expect(await manager.saveGroqKey("gsk-test-only-unsaved")).toEqual(NOT_SAVED);
    expect(await manager.getGroqKey()).toBe("gsk-test-only-unsaved");

    fs.chmodSync(storePath(), 0o666);
    // After a restart the unsaved key is gone and the earlier one is still there.
    const restarted = new EnvironmentManager(runtime());
    expect(await restarted.getGroqKey()).toBe("");
    expect(await restarted.getOpenAIKey()).toBe("sk-test-only-before");
  });

  it("reports failure through the onboarding helper too", async () => {
    await new EnvironmentManager(runtime()).saveGroqKey("gsk-test-only-before");
    fs.chmodSync(storePath(), 0o444);

    const result = await new EnvironmentManager(runtime()).createProductionEnvFile("sk-x");

    expect(result).toMatchObject(NOT_SAVED);
  });

  it("reports failure when there is no encryption and the plain file cannot be written", async () => {
    encryptionAvailable = false;
    const manager = new EnvironmentManager(runtime());
    await manager.ready;
    fs.rmSync(plainPath());
    fs.mkdirSync(plainPath());

    expect(await manager.saveOpenAIKey("sk-test-only-unsaved")).toEqual(NOT_SAVED);
  });

  it("reports success when a key is only cleared while keys.enc is unreadable", async () => {
    // The unreadable store is left for the next start to try again, which
    // loses nothing, so there is nothing to warn about.
    await new EnvironmentManager(runtime()).saveOpenAIKey("sk-test-only-saved");
    decryptShouldThrow = true;

    expect(await new EnvironmentManager(runtime()).saveGroqKey("")).toEqual({ success: true });
  });

  it("reports success for a plain setting, which never touches keys.enc", async () => {
    expect(await new EnvironmentManager(runtime()).saveDictationKey("F9")).toEqual({
      success: true,
    });
    delete process.env.DICTATION_KEY;
  });
});
