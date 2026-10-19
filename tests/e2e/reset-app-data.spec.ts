import fs from "node:fs";
import path from "node:path";
import { expect, test } from "./fixtures/electron-app";

/**
 * Reset app data used to delete the data folder while the app still had its
 * files open. The first open file stopped the delete, nothing said so, and the
 * app restarted with the API keys, the history and the logs still on disk. Now
 * the running app leaves a marker and restarts, and the next start empties the
 * folder before it opens anything.
 *
 * The app's own restart is replaced with a counter: a real relaunch would start
 * a copy this test does not control, on the developer's screen. The fixture's
 * relaunch stands in for it, against the same data folder.
 */

// The model caches are cleared from the home folder, so it has to be a throwaway.
// Log files are only written at the debug level.
test.use({ useThrowawayHome: true, appEnv: { PT_LOG_LEVEL: "debug" } });

const SENTINEL_KEY = "sk-e2e-reset-sentinel";

type RestartCounter = {
  relaunch: number;
  quit: number;
  realRelaunch: () => void;
  realQuit: () => void;
};

test("Reset app data leaves no keys, history, logs or Local Storage after the restart", async ({
  electronApp,
  controlPanel,
  userDataDir,
  fakeHomeDir,
  relaunchElectronApp,
}) => {
  const appPaths = await electronApp.evaluate(({ app }) => ({
    userData: app.getPath("userData"),
    home: app.getPath("home"),
  }));
  expect(path.resolve(appPaths.userData)).toBe(path.resolve(userDataDir));
  expect(path.resolve(appPaths.home)).toBe(path.resolve(fakeHomeDir as string));

  const modelFile = path.join(
    fakeHomeDir as string,
    ".cache",
    "PrivateTranscribe",
    "whisper-models",
    "ggml-reset-test.bin"
  );
  fs.mkdirSync(path.dirname(modelFile), { recursive: true });
  fs.writeFileSync(modelFile, "model");

  await controlPanel.evaluate(async (key) => {
    localStorage.setItem("openaiApiKey", key);
    await window.electronAPI.saveOpenAIKey(key);
    await window.electronAPI.saveTranscription("This dictation must not survive a reset.", 5);
  }, SENTINEL_KEY);
  const logsDir = path.join(userDataDir, "logs");
  const firstRunLogs = fs.readdirSync(logsDir);
  const keyStorePath = path.join(userDataDir, "keys.enc");
  const keyStoreWithKey = fs.readFileSync(keyStorePath);
  expect(firstRunLogs.length).toBeGreaterThan(0);

  await electronApp.evaluate(({ app }) => {
    const counter: RestartCounter = {
      relaunch: 0,
      quit: 0,
      realRelaunch: app.relaunch,
      realQuit: app.quit,
    };
    (globalThis as { __resetRestart?: RestartCounter }).__resetRestart = counter;
    app.relaunch = () => {
      counter.relaunch += 1;
    };
    app.quit = () => {
      counter.quit += 1;
    };
    if (app.relaunch === counter.realRelaunch || app.quit === counter.realQuit) {
      throw new Error("Could not replace the app's restart; refusing to press Reset");
    }
  });

  await controlPanel.getByRole("button", { name: "Settings", exact: true }).click();
  await controlPanel.getByRole("button", { name: "Data & Storage", exact: true }).click();
  await controlPanel
    .locator('[data-settings-label="Reset app data"]')
    .getByRole("button", { name: "Reset", exact: true })
    .click();
  await controlPanel.getByRole("button", { name: "Delete Everything", exact: true }).click();

  await expect(controlPanel.getByText("Restarting", { exact: true })).toBeVisible();
  await expect
    .poll(() =>
      electronApp.evaluate(() => {
        const counter = (globalThis as { __resetRestart?: RestartCounter }).__resetRestart;
        return { relaunch: counter?.relaunch, quit: counter?.quit };
      })
    )
    .toEqual({ relaunch: 1, quit: 1 });

  // The running app's half: the marker, and the model cache already gone.
  expect(fs.existsSync(path.join(userDataDir, ".reset-pending"))).toBe(true);
  expect(fs.existsSync(modelFile)).toBe(false);

  await electronApp.evaluate(({ app }) => {
    const counter = (globalThis as { __resetRestart?: RestartCounter }).__resetRestart;
    if (!counter) return;
    app.relaunch = counter.realRelaunch;
    app.quit = counter.realQuit;
  });

  const { controlPanel: restartedPanel } = await relaunchElectronApp();

  expect(fs.existsSync(path.join(userDataDir, ".reset-pending"))).toBe(false);
  // The new start writes an empty key store of its own; the one holding the
  // key must be gone.
  if (fs.existsSync(keyStorePath)) {
    expect(fs.readFileSync(keyStorePath).equals(keyStoreWithKey)).toBe(false);
  }
  expect(fs.readdirSync(logsDir).filter((name) => firstRunLogs.includes(name))).toEqual([]);

  const after = await restartedPanel.evaluate(async () => ({
    storedKey: localStorage.getItem("openaiApiKey"),
    savedKey: await window.electronAPI.getOpenAIKey(),
    history: await window.electronAPI.getTranscriptions(50),
  }));
  expect(after.storedKey).not.toBe(SENTINEL_KEY);
  expect(after.savedKey || "").toBe("");
  expect(after.history).toEqual([]);

  // The new log says the reset finished with nothing left over.
  const newLog = fs
    .readdirSync(logsDir)
    .map((name) => fs.readFileSync(path.join(logsDir, name), "utf8"))
    .join("\n");
  expect(newLog).toMatch(/App data reset finished[\s\S]{0,120}"leftOver": \[\]/);
});
