import fs from "node:fs";
import path from "node:path";
import { expect, test } from "./fixtures/electron-app";

/**
 * Saved API keys load and save through Electron's async safeStorage API, and a
 * keys.enc that the old synchronous encryptString wrote still loads.
 *
 * Electron 45 deprecated the sync API and Electron 46 removes it, so every
 * user's existing store was written by encryptString. The test writes one with
 * the real OS key, restarts the app, and reads the key back.
 *
 * Keys here are made up; the fixture blanks every real key in the environment.
 */

const SYNC_WRITTEN_KEY = "sk-e2e-made-up-sync-written";
const ASYNC_SAVED_KEY = "gsk-e2e-made-up-async-saved";

test("a key store written by the sync API loads, and a new key survives a restart", async ({
  electronApp,
  userDataDir,
  relaunchElectronApp,
}) => {
  const legacyStore = await electronApp.evaluate(({ safeStorage }, key) => {
    const legacy = safeStorage as unknown as {
      encryptString?: (plain: string) => Buffer;
    };
    if (typeof legacy.encryptString !== "function") return null;
    return legacy.encryptString(JSON.stringify({ OPENAI_API_KEY: key })).toString("base64");
  }, SYNC_WRITTEN_KEY);
  test.skip(
    legacyStore === null,
    "This Electron has no sync encryptString left to write an old-style store with"
  );

  const storePath = path.join(userDataDir, "keys.enc");
  fs.writeFileSync(storePath, Buffer.from(legacyStore as string, "base64"));
  // The running app holds no keys, and its startup sync would write that empty
  // set over the store before the restart. Read-only, it cannot.
  fs.chmodSync(storePath, 0o444);

  let { controlPanel } = await relaunchElectronApp();
  expect(await controlPanel.evaluate(() => window.electronAPI.getOpenAIKey())).toBe(
    SYNC_WRITTEN_KEY
  );

  fs.chmodSync(storePath, 0o666);
  const before = fs.readFileSync(storePath);
  await controlPanel.evaluate((key) => window.electronAPI.saveGroqKey(key), ASYNC_SAVED_KEY);
  const after = fs.readFileSync(storePath);
  expect(after.equals(before)).toBe(false);
  for (const key of [SYNC_WRITTEN_KEY, ASYNC_SAVED_KEY]) {
    expect(after.includes(Buffer.from(key))).toBe(false);
  }

  ({ controlPanel } = await relaunchElectronApp());
  expect(
    await controlPanel.evaluate(async () => [
      await window.electronAPI.getOpenAIKey(),
      await window.electronAPI.getGroqKey(),
    ])
  ).toEqual([SYNC_WRITTEN_KEY, ASYNC_SAVED_KEY]);
});
