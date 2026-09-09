import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  _electron as electron,
  test as base,
  expect,
  type ElectronApplication,
  type Page,
} from "@playwright/test";

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");

/**
 * API key names EnvironmentManager reads from the environment. The app also
 * falls back to the repo-root `.env`, which on a developer machine holds real
 * paid keys. Blanking them here keeps e2e runs from ever reaching a provider —
 * dotenv does not overwrite variables that are already present.
 */
const API_KEY_VARS = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GEMINI_API_KEY",
  "GROQ_API_KEY",
  "CUSTOM_TRANSCRIPTION_API_KEY",
  "CUSTOM_REASONING_API_KEY",
];

/**
 * Diagnostic switches main.js already honours. They keep a test run from
 * touching machine-global state: registering the user's real dictation hotkey,
 * spawning the native key listener, or leaving a tray icon and its health-check
 * timers behind.
 */
const DEFAULT_DIAG_FLAGS: Record<string, string> = {
  PRIVATETRANSCRIBE_DIAG_DISABLE_GLOBAL_SHORTCUT: "1",
  PRIVATETRANSCRIBE_DIAG_DISABLE_WINDOWS_KEY_LISTENER: "1",
  PRIVATETRANSCRIBE_DIAG_DISABLE_TRAY: "1",
  // Read Aloud quiets every other app's audio session while it reads. A test
  // run must never do that to the machine it is running on — it would move the
  // volume of whatever the developer is listening to. The wiring is still
  // exercised: the module counts the calls it would have made and reports them
  // through the playback-active reply.
  PRIVATETRANSCRIBE_DIAG_DISABLE_AUDIO_DUCKING: "1",
  // Agent Mode rewrites through the developer's own Claude Code login. A test
  // run must never spend that subscription; the one spec that needs a rewrite
  // points the spawn at tests/e2e/fixtures/claude-print-stub.cjs instead.
  PRIVATETRANSCRIBE_DIAG_DISABLE_AGENT_REWRITE: "1",
};

export type ConsoleEntry = { type: string; text: string };

/**
 * The real profile's binary directory, where the downloaded CUDA whisper-server
 * package lands. Mirrors app.getPath("userData") + "/bin" for the product name
 * this app ships under.
 */
function installedCudaBinDir(): string {
  if (process.platform !== "win32") {
    throw new Error("seedCudaEngine: only wired up for Windows, where the CUDA package ships");
  }
  const appData = process.env.APPDATA;
  if (!appData) throw new Error("seedCudaEngine: APPDATA is not set");
  return path.join(appData, "PrivateTranscribe", "bin");
}

/** Hardlink the installed CUDA package into a throwaway profile's bin dir. */
function seedCudaEngineInto(userDataDir: string): void {
  const source = installedCudaBinDir();
  if (!fs.existsSync(source)) {
    throw new Error(
      `seedCudaEngine: no CUDA engine installed on this machine. Expected it at ${source} — download it from Settings first.`
    );
  }

  const target = path.join(userDataDir, "bin");
  fs.mkdirSync(target, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    try {
      fs.linkSync(from, to);
    } catch {
      // Different volume, or the filesystem refuses the link.
      fs.copyFileSync(from, to);
    }
  }
}

/** The one Kokoro model in the registry; seeded by `seedKokoroModel`. */
const KOKORO_MODEL_ID = "kokoro-82m-v1.0-fp32";

type KokoroRegistryEntry = { hfRepo: string; files: { relPath: string }[] };

/** Mirrors getModelsDirForService("kokoro") under an arbitrary home directory. */
const kokoroCacheRoot = (home: string, hfRepo: string) =>
  path.join(home, ".cache", "PrivateTranscribe", "kokoro-models", ...hfRepo.split("/"));

/**
 * Hardlink the machine's real Kokoro model into the fake home so the app loads
 * it through its normal model-manager path. Copies only if hardlinking fails
 * (different volume).
 */
function seedKokoroModelInto(fakeHome: string, info: KokoroRegistryEntry | undefined): void {
  if (!info) {
    throw new Error(`seedKokoroModel: "${KOKORO_MODEL_ID}" is not in the kokoro model registry`);
  }

  const realRoot = kokoroCacheRoot(os.homedir(), info.hfRepo);
  const fakeRoot = kokoroCacheRoot(fakeHome, info.hfRepo);

  for (const file of info.files) {
    const src = path.join(realRoot, ...file.relPath.split("/"));
    if (!fs.existsSync(src)) {
      throw new Error(
        `Kokoro model not installed on this machine — run the download first. Missing: ${src}`
      );
    }
    const dest = path.join(fakeRoot, ...file.relPath.split("/"));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    try {
      fs.linkSync(src, dest);
    } catch {
      fs.copyFileSync(src, dest);
    }
  }
}

export type PrivateTranscribeOptions = {
  /**
   * Mark onboarding complete before assertions run, so specs land on the real
   * control panel instead of the first-run wizard. Set false to test onboarding.
   */
  completeOnboarding: boolean;
  /** Extra environment variables for the launched app (overrides defaults). */
  appEnv: Record<string, string>;
  /**
   * Extra command-line arguments for the launched app, placed before the app
   * path. Lets a spec reproduce a login launch (`--launch-at-login
   * --startup-mode=tray`) without touching the machine's Run key.
   */
  appArgs: string[];
  /**
   * Exact contents to write to `analytics-consent.txt` before launch.
   *
   * The consent file is versioned, and an upgrade is the only way to reach the
   * migration branch: a developer's own machine has already been rewritten to
   * the current version by the build they are running, so nothing they do
   * locally exercises what every existing user will hit. Defaults to "denied",
   * which keeps ordinary specs off the network and out of the modal.
   */
  seedConsentFile: string;
  /**
   * Whisper models the app should see as already downloaded, e.g. `["base"]`.
   *
   * The model picker drops a selection whose model is not on disk and snaps to
   * the first downloaded one, so any spec that asserts on a specific model has
   * to own that state instead of inheriting whatever the developer happens to
   * have in `~/.cache`. Seeding redirects the cache to a throwaway home
   * directory holding correctly-sized placeholder files.
   */
  seedWhisperModels: string[];
  /**
   * Whisper models the app should be able to actually DECODE with, e.g.
   * `["small-en-tdrz"]`.
   *
   * The truncated placeholders above are enough to satisfy a status check and
   * useless to whisper.cpp. This hardlinks the machine's own model file into the
   * throwaway home instead, so a spec can control which models exist while still
   * running a real decode. Throws when the model is not on the machine — a spec
   * that silently skipped would be hiding the failure that matters.
   */
  seedRealWhisperModels: string[];
  /**
   * Make the real Kokoro TTS model visible to the app under the throwaway home
   * directory, and turn on the dev-only Read Aloud test surface.
   *
   * Unlike the whisper seeds, this cannot be faked with a truncated file — the
   * ONNX runtime actually loads the weights. The real model is hardlinked in,
   * so a run costs no disk and no download. If the model is not on the machine
   * the fixture throws: the app must never download it implicitly, so a spec
   * that silently skipped would be hiding exactly the failure that matters.
   */
  seedKokoroModel: boolean;
  /**
   * Point the app's home directory at an empty throwaway dir without seeding
   * anything into it.
   *
   * A spec that asserts on a *missing* model has the same problem as one that
   * asserts on a present one: the developer's real `~/.cache` decides the
   * result. This is how a "not downloaded yet" state is tested on a machine
   * that has the model.
   */
  useThrowawayHome: boolean;
  /**
   * Hardlink the machine's installed CUDA whisper-server package into the
   * throwaway profile, so the app reports the GPU engine it really has.
   *
   * The package lives in userData, which every run throws away, so a spec that
   * asserts on GPU state otherwise always sees "CPU" no matter what the machine
   * is. Hardlinks keep a run free: the package is roughly a gigabyte. Throws
   * when it is not installed, because a spec that silently fell back to CPU
   * would be hiding the thing it set out to check.
   */
  seedCudaEngine: boolean;
  /**
   * Absolute path to a PCM WAV that Chromium plays back in place of the real
   * microphone, for specs that dictate through the app's own audio pipeline.
   *
   * This is the only honest way to test dictation end to end without opening
   * the machine's microphone: `--use-fake-device-for-media-stream` swaps the
   * capture device, `--use-file-for-fake-audio-capture` gives that device this
   * file to play (on a loop), and `--use-fake-ui-for-media-stream`
   * auto-accepts the permission prompt. getUserMedia, MediaRecorder and
   * everything downstream of them run exactly as they do for a user.
   *
   * Empty (the default) leaves the launch arguments untouched, so no other spec
   * changes behaviour.
   */
  fakeAudioCaptureFile: string;
};

/**
 * A freshly launched app and its windows, handed back by a relaunch.
 *
 * `overlayWindow` is null when the spec launched with
 * PRIVATETRANSCRIBE_DIAG_DISABLE_OVERLAY_WINDOW — there is no window to hand
 * back, and waiting for one would hang the relaunch.
 */
export type RelaunchResult = {
  electronApp: ElectronApplication;
  overlayWindow: Page | null;
  controlPanel: Page;
};

export type PrivateTranscribeFixtures = {
  /** Throwaway Electron userData dir — database, settings, and consent live here. */
  userDataDir: string;
  /** Throwaway home dir backing `seedWhisperModels`; null when nothing is seeded. */
  fakeHomeDir: string | null;
  electronApp: ElectronApplication;
  /**
   * Close the running app and start a new one against the SAME userData dir,
   * fake home, and environment — an app restart, not a second app.
   *
   * This exists for anything that has to survive a restart (a persisted session
   * id, a database row, a settings file): the only honest way to test it is to
   * end the process that wrote it and read it back from one that never saw it.
   *
   * The returned windows replace the `overlayWindow` / `controlPanel` fixtures,
   * which point at the old, now-destroyed instance.
   */
  relaunchElectronApp: () => Promise<RelaunchResult>;
  /** The always-on-top dictation overlay (index.html, no query). */
  overlayWindow: Page;
  /** The settings/history window (index.html?panel=true). */
  controlPanel: Page;
  /** Every console message emitted by any renderer window during the test. */
  consoleMessages: ConsoleEntry[];
};

const isControlPanelUrl = (url: string) => url.includes("panel=true");
const isOverlayUrl = (url: string) => !isControlPanelUrl(url) && url.includes("index.html");
const isFlagOn = (value?: string) => ["1", "true", "yes", "on"].includes(value ?? "");

/**
 * Keep the app off the developer's screen. A test run opens the always-on-top
 * overlay and the control panel once per spec; left alone they steal focus,
 * cover whatever you are working on, and eat clicks through the transparent
 * overlay region.
 *
 * Windows are made invisible and click-through rather than hidden, so the
 * compositor keeps painting and failure screenshots still show real UI. The
 * setters the app re-asserts during startup are then stubbed out so it cannot
 * undo any of it.
 *
 * `muteAudio` additionally mutes every window's output, for specs that play
 * real audio. Muting only silences the output device — WebAudio's clock keeps
 * running, so playback state and timing assertions are unaffected.
 */
async function silenceWindows(app: ElectronApplication, muteAudio = false): Promise<void> {
  await app.evaluate(({ app: electronApp, BrowserWindow }, shouldMute) => {
    const silence = (win: Electron.BrowserWindow) => {
      if (!win || win.isDestroyed()) return;

      // Keep working references before the public setters are stubbed out.
      const real = {
        setAlwaysOnTop: win.setAlwaysOnTop.bind(win),
        setSkipTaskbar: win.setSkipTaskbar.bind(win),
        setOpacity: win.setOpacity.bind(win),
        setIgnoreMouseEvents: win.setIgnoreMouseEvents.bind(win),
      };

      const enforce = () => {
        if (win.isDestroyed()) return;
        try {
          real.setAlwaysOnTop(false);
          real.setSkipTaskbar(true);
          real.setOpacity(0);
          real.setIgnoreMouseEvents(true);
          if (shouldMute) win.webContents.setAudioMuted(true);
        } catch {
          // Some setters are platform-specific; losing one is not fatal here.
        }
      };

      win.setAlwaysOnTop = () => {};
      win.setOpacity = () => {};
      win.setIgnoreMouseEvents = () => {};
      win.moveTop = () => {};
      win.focus = () => {};
      win.setSkipTaskbar = () => {};
      // showInactive() presents the window without activating it, so the app's
      // own show() calls no longer pull focus away from the foreground app.
      win.show = () => win.showInactive();

      // browser-window-created fires from inside the constructor, before
      // Electron applies options like alwaysOnTop, so a single pass here would
      // be overwritten. Re-assert on every point the window becomes visible.
      enforce();
      win.once("ready-to-show", enforce);
      win.on("show", enforce);
      win.on("restore", enforce);
    };

    BrowserWindow.getAllWindows().forEach(silence);
    electronApp.on("browser-window-created", (_event, win) => silence(win));
  }, muteAudio);
}

async function findWindow(
  app: ElectronApplication,
  predicate: (page: Page) => boolean,
  label: string,
  timeoutMs = 30_000
): Promise<Page> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const match = app.windows().find(predicate);
    if (match) {
      await match.waitForLoadState("domcontentloaded");
      return match;
    }
    if (Date.now() > deadline) {
      const seen = app
        .windows()
        .map((w) => w.url())
        .join(", ");
      throw new Error(`Timed out waiting for the ${label} window. Open windows: [${seen}]`);
    }
    await app
      .waitForEvent("window", { timeout: Math.max(250, deadline - Date.now()) })
      .catch(() => {
        // Fall through and re-check the window list; a window may have opened
        // between our snapshot and the listener being attached.
      });
  }
}

/**
 * Everything a launch needs, held so a relaunch can reproduce it byte for byte.
 * The dirs are deliberately NOT re-created here: a restart that got a fresh
 * userData would prove nothing about what survives one.
 */
type LaunchInputs = {
  env: Record<string, string>;
  userDataDir: string;
  fakeHomeDir: string | null;
  consoleMessages: ConsoleEntry[];
  muteAudio: boolean;
  fakeAudioCaptureFile: string;
  appArgs: string[];
};

/**
 * Launch Electron and bring it to the state every spec expects: invisible,
 * silent, pointed at the fake home, both windows loaded, console recorded, and
 * tracing started. Used for the first launch and for every relaunch, so the two
 * cannot drift apart.
 */
async function launchApp(inputs: LaunchInputs): Promise<ElectronApplication> {
  const {
    env,
    userDataDir,
    fakeHomeDir,
    consoleMessages,
    muteAudio,
    fakeAudioCaptureFile,
    appArgs,
  } = inputs;

  const args = [
    `--user-data-dir=${userDataDir}`,
    // The windows are made invisible below; without these, Chromium treats
    // them as occluded and throttles rendering and timers.
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--disable-background-timer-throttling",
  ];

  if (fakeAudioCaptureFile) {
    if (!fs.existsSync(fakeAudioCaptureFile)) {
      throw new Error(`fakeAudioCaptureFile does not exist: ${fakeAudioCaptureFile}`);
    }
    args.push(
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      `--use-file-for-fake-audio-capture=${fakeAudioCaptureFile}`
    );
  }

  args.push(...appArgs, ".");

  const app = await electron.launch({
    cwd: REPO_ROOT,
    env,
    args,
    timeout: 60_000,
  });

  await silenceWindows(app, muteAudio);

  // The model cache resolves under app.getPath("home"), which Chromium reads
  // from the OS rather than USERPROFILE/HOME — so redirecting it has to
  // happen in the main process. getModelsDirForService() resolves per call,
  // so this takes effect for every later lookup; specs reload the window
  // they assert on, which re-runs the picker's model query.
  if (fakeHomeDir) {
    await app.evaluate(
      ({ app: electronApp }, dir) => electronApp.setPath("home", dir),
      fakeHomeDir
    );
  }

  // Startup is only finished once both windows have loaded. Closing the app
  // before then aborts the in-flight loadFile(), which surfaces in main.js as
  // a startup failure — an error dialog on screen and a hung teardown.
  if (!isFlagOn(env.PRIVATETRANSCRIBE_DIAG_DISABLE_CONTROL_PANEL_WINDOW)) {
    const panel = await findWindow(app, (w) => isControlPanelUrl(w.url()), "control panel");
    await panel.waitForLoadState("load");
  }
  if (!isFlagOn(env.PRIVATETRANSCRIBE_DIAG_DISABLE_OVERLAY_WINDOW)) {
    const overlay = await findWindow(app, (w) => isOverlayUrl(w.url()), "dictation overlay");
    await overlay.waitForLoadState("load");
  }

  const recordConsole = (page: Page) => {
    page.on("console", (message) => {
      consoleMessages.push({ type: message.type(), text: message.text() });
    });
    page.on("pageerror", (error) => {
      consoleMessages.push({ type: "pageerror", text: error.message });
    });
  };
  app.windows().forEach(recordConsole);
  app.on("window", recordConsole);

  // Traces are captured manually: Playwright's `use.trace` option only covers
  // browser contexts created by the runner, not an Electron app's context.
  await app.context().tracing.start({ screenshots: true, snapshots: true, sources: true });

  return app;
}

/**
 * Shut the app down with a bound. If the main process ever blocks on a native
 * dialog, app.close() never resolves and the whole worker dies on a teardown
 * timeout instead of reporting the real failure.
 */
async function closeApp(app: ElectronApplication): Promise<void> {
  const child = app.process();
  const closed = app.close().then(
    () => true,
    () => true
  );
  const settled = await Promise.race([
    closed,
    new Promise<false>((resolve) => setTimeout(() => resolve(false), 15_000)),
  ]);
  if (!settled && child.pid && child.exitCode === null) {
    console.warn(`[e2e] Electron did not exit cleanly; killing pid ${child.pid}`);
    try {
      process.kill(child.pid);
    } catch {
      // Already gone.
    }
  }
}

/**
 * Mark onboarding complete in the control panel's renderer and return the page
 * that is showing the real UI. localStorage lives in the renderer's LevelDB
 * store, so it can only be seeded after first paint — hence the reload.
 */
async function ensureOnboarded(app: ElectronApplication, complete: boolean): Promise<Page> {
  let page = await findWindow(app, (w) => isControlPanelUrl(w.url()), "control panel");
  if (!complete) return page;

  const alreadyDone = await page.evaluate(
    () => localStorage.getItem("onboardingCompleted") === "true"
  );
  if (!alreadyDone) {
    await page.evaluate(() => localStorage.setItem("onboardingCompleted", "true"));
    await page.reload({ waitUntil: "domcontentloaded" });
    page = await findWindow(app, (w) => isControlPanelUrl(w.url()), "control panel");
  }

  // Converse's hands-free microphone ships on, so any spec that starts a
  // session would otherwise open the developer's real microphone while they
  // are sitting at the machine. A spec that wants it sets it back to "true"
  // itself, and then had better be driving a fake capture device.
  await page.evaluate(() => {
    if (localStorage.getItem("converseVoiceEnabled") === null) {
      localStorage.setItem("converseVoiceEnabled", "false");
    }
  });

  return page;
}

/** Owns the app process across restarts, so teardown always sees the live one. */
type AppController = {
  readonly app: ElectronApplication;
  relaunch: () => Promise<RelaunchResult>;
};

type InternalFixtures = {
  appController: AppController;
};

export const test = base.extend<
  PrivateTranscribeOptions & PrivateTranscribeFixtures & InternalFixtures
>({
  completeOnboarding: [true, { option: true }],
  appEnv: [{}, { option: true }],
  appArgs: [[], { option: true }],
  seedConsentFile: ["denied", { option: true }],
  seedWhisperModels: [[], { option: true }],
  seedRealWhisperModels: [[], { option: true }],
  seedKokoroModel: [false, { option: true }],
  useThrowawayHome: [false, { option: true }],
  seedCudaEngine: [false, { option: true }],
  fakeAudioCaptureFile: ["", { option: true }],

  fakeHomeDir: async (
    { seedWhisperModels, seedRealWhisperModels, seedKokoroModel, useThrowawayHome },
    use
  ) => {
    if (
      seedWhisperModels.length === 0 &&
      seedRealWhisperModels.length === 0 &&
      !seedKokoroModel &&
      !useThrowawayHome
    ) {
      await use(null);
      return;
    }

    const registry = JSON.parse(
      fs.readFileSync(path.join(REPO_ROOT, "src", "models", "modelRegistryData.json"), "utf8")
    ) as {
      whisperModels: Record<string, { fileName: string; sizeMb: number }>;
      kokoroModels: Record<string, KokoroRegistryEntry>;
    };

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-e2e-home-"));

    if (seedWhisperModels.length > 0) {
      // Mirrors getModelsDirForService("whisper"), which resolves under the
      // home directory Electron reports.
      const modelsDir = path.join(dir, ".cache", "PrivateTranscribe", "whisper-models");
      fs.mkdirSync(modelsDir, { recursive: true });

      for (const model of seedWhisperModels) {
        const info = registry.whisperModels[model];
        if (!info) {
          throw new Error(`seedWhisperModels: "${model}" is not in the whisper model registry`);
        }
        // checkModelStatus only reads the file size, so an empty file truncated
        // to the registry size reads as a complete download without writing
        // hundreds of megabytes.
        const handle = fs.openSync(path.join(modelsDir, info.fileName), "w");
        try {
          fs.ftruncateSync(handle, info.sizeMb * 1_000_000);
        } finally {
          fs.closeSync(handle);
        }
      }
    }

    if (seedRealWhisperModels.length > 0) {
      const modelsDir = path.join(dir, ".cache", "PrivateTranscribe", "whisper-models");
      const realModelsDir = path.join(
        os.homedir(),
        ".cache",
        "PrivateTranscribe",
        "whisper-models"
      );
      fs.mkdirSync(modelsDir, { recursive: true });

      for (const model of seedRealWhisperModels) {
        const info = registry.whisperModels[model];
        if (!info) {
          throw new Error(`seedRealWhisperModels: "${model}" is not in the whisper model registry`);
        }
        const src = path.join(realModelsDir, info.fileName);
        if (!fs.existsSync(src)) {
          throw new Error(
            `Whisper model "${model}" is not installed on this machine — download it first. Missing: ${src}`
          );
        }
        try {
          fs.linkSync(src, path.join(modelsDir, info.fileName));
        } catch {
          fs.copyFileSync(src, path.join(modelsDir, info.fileName));
        }
      }
    }

    if (seedKokoroModel) {
      seedKokoroModelInto(dir, registry.kokoroModels?.[KOKORO_MODEL_ID]);
    }

    await use(dir);

    // Only unlinks the hardlinks — the machine's real model is untouched.
    fs.rmSync(dir, { recursive: true, force: true });
  },

  userDataDir: async ({ seedConsentFile, seedCudaEngine }, use, testInfo) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-e2e-"));

    if (seedCudaEngine) seedCudaEngineInto(dir);

    // Pre-deny analytics so no run phones home and the consent modal never
    // covers the UI a spec is asserting against. Specs that test the consent
    // migration itself override this with seedConsentFile.
    fs.writeFileSync(path.join(dir, "analytics-consent.txt"), seedConsentFile, "utf8");

    await use(dir);

    // Keep the profile when a test fails — the sqlite db and debug log are the
    // first things worth reading during triage.
    if (testInfo.status === testInfo.expectedStatus) {
      fs.rmSync(dir, { recursive: true, force: true });
    } else {
      console.log(`[e2e] Kept failing run's userData at ${dir}`);
    }
  },

  consoleMessages: async ({}, use) => {
    await use([]);
  },

  appController: async (
    {
      userDataDir,
      fakeHomeDir,
      appEnv,
      appArgs,
      consoleMessages,
      seedKokoroModel,
      completeOnboarding,
      fakeAudioCaptureFile,
    },
    use,
    testInfo
  ) => {
    const env: Record<string, string> = { ...process.env } as Record<string, string>;

    // Playwright's runner sets this for its own worker process; inheriting it
    // would make Electron boot as plain Node and never open a window.
    delete env.ELECTRON_RUN_AS_NODE;

    // Production mode makes windowManager load the built bundle from
    // src/dist via loadFile() instead of waiting on the Vite dev server.
    env.NODE_ENV = "production";
    env.PT_LOG_LEVEL = env.PT_LOG_LEVEL || "info";

    for (const key of API_KEY_VARS) env[key] = "";
    Object.assign(env, DEFAULT_DIAG_FLAGS);
    if (seedKokoroModel) {
      // Only a run that seeded the model gets the headless Read Aloud handle.
      env.PRIVATETRANSCRIBE_DIAG_ENABLE_READALOUD_TEST = "1";
    }
    Object.assign(env, appEnv);

    const inputs: LaunchInputs = {
      env,
      userDataDir,
      fakeHomeDir,
      consoleMessages,
      muteAudio: seedKokoroModel,
      fakeAudioCaptureFile,
      appArgs,
    };

    let app = await launchApp(inputs);

    const controller: AppController = {
      get app() {
        return app;
      },
      async relaunch() {
        // The old instance's trace is discarded: a restart spec's evidence is
        // what the new instance reports, and the failure capture below runs
        // against whichever instance is live when the test ends.
        await app.context().tracing.stop();
        await closeApp(app);

        app = await launchApp(inputs);
        const controlPanel = await ensureOnboarded(app, completeOnboarding);
        const overlayWindow = isFlagOn(env.PRIVATETRANSCRIBE_DIAG_DISABLE_OVERLAY_WINDOW)
          ? null
          : await findWindow(app, (w) => isOverlayUrl(w.url()), "overlay");
        return { electronApp: app, overlayWindow, controlPanel };
      },
    };

    await use(controller);

    const failed = testInfo.status !== testInfo.expectedStatus;
    if (failed) {
      const tracePath = testInfo.outputPath("trace.zip");
      await app.context().tracing.stop({ path: tracePath });
      await testInfo.attach("trace", { path: tracePath, contentType: "application/zip" });

      for (const [index, page] of app.windows().entries()) {
        const shot = await page.screenshot({ fullPage: true }).catch(() => null);
        if (shot) {
          await testInfo.attach(`window-${index}`, { body: shot, contentType: "image/png" });
        }
      }
      if (consoleMessages.length) {
        await testInfo.attach("console", {
          body: consoleMessages.map((m) => `[${m.type}] ${m.text}`).join("\n"),
          contentType: "text/plain",
        });
      }
    } else {
      await app.context().tracing.stop();
    }

    await closeApp(app);
  },

  electronApp: async ({ appController }, use) => {
    await use(appController.app);
  },

  relaunchElectronApp: async ({ appController }, use) => {
    await use(() => appController.relaunch());
  },

  controlPanel: async ({ electronApp, completeOnboarding }, use) => {
    await use(await ensureOnboarded(electronApp, completeOnboarding));
  },

  overlayWindow: async ({ electronApp }, use) => {
    const page = await findWindow(electronApp, (w) => isOverlayUrl(w.url()), "dictation overlay");
    await use(page);
  },
});

export { expect };
