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
};

export type ConsoleEntry = { type: string; text: string };

export type PrivateTranscribeOptions = {
  /**
   * Mark onboarding complete before assertions run, so specs land on the real
   * control panel instead of the first-run wizard. Set false to test onboarding.
   */
  completeOnboarding: boolean;
  /** Extra environment variables for the launched app (overrides defaults). */
  appEnv: Record<string, string>;
};

export type PrivateTranscribeFixtures = {
  /** Throwaway Electron userData dir — database, settings, and consent live here. */
  userDataDir: string;
  electronApp: ElectronApplication;
  /** The always-on-top dictation overlay (index.html, no query). */
  overlayWindow: Page;
  /** The settings/history window (index.html?panel=true). */
  controlPanel: Page;
  /** Every console message emitted by any renderer window during the test. */
  consoleMessages: ConsoleEntry[];
};

const isControlPanelUrl = (url: string) => url.includes("panel=true");

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
 */
async function silenceWindows(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ app: electronApp, BrowserWindow }) => {
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
  });
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
    await app.waitForEvent("window", { timeout: Math.max(250, deadline - Date.now()) }).catch(() => {
      // Fall through and re-check the window list; a window may have opened
      // between our snapshot and the listener being attached.
    });
  }
}

export const test = base.extend<PrivateTranscribeOptions & PrivateTranscribeFixtures>({
  completeOnboarding: [true, { option: true }],
  appEnv: [{}, { option: true }],

  userDataDir: async ({}, use, testInfo) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-e2e-"));

    // Pre-deny analytics so no run phones home and the consent modal never
    // covers the UI a spec is asserting against.
    fs.writeFileSync(path.join(dir, "analytics-consent.txt"), "denied", "utf8");

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

  electronApp: async ({ userDataDir, appEnv, consoleMessages }, use, testInfo) => {
    const env: Record<string, string> = { ...process.env } as Record<string, string>;

    // Playwright's runner sets this for its own worker process; inheriting it
    // would make Electron boot as plain Node and never open a window.
    delete env.ELECTRON_RUN_AS_NODE;

    // Production mode makes windowManager load the built bundle from
    // src/dist via loadFile() instead of waiting on the Vite dev server.
    env.NODE_ENV = "production";
    env.PT_LOG_LEVEL = env.PT_LOG_LEVEL || "info";

    for (const key of API_KEY_VARS) env[key] = "";
    Object.assign(env, DEFAULT_DIAG_FLAGS, appEnv);

    const app = await electron.launch({
      cwd: REPO_ROOT,
      env,
      args: [
        `--user-data-dir=${userDataDir}`,
        // The windows are made invisible below; without these, Chromium treats
        // them as occluded and throttles rendering and timers.
        "--disable-backgrounding-occluded-windows",
        "--disable-renderer-backgrounding",
        "--disable-background-timer-throttling",
        ".",
      ],
      timeout: 60_000,
    });

    await silenceWindows(app);

    // Startup is only finished once both windows have loaded. Closing the app
    // before then aborts the in-flight loadFile(), which surfaces in main.js as
    // a startup failure — an error dialog on screen and a hung teardown.
    const isFlagOn = (value?: string) => ["1", "true", "yes", "on"].includes(value ?? "");
    if (!isFlagOn(env.PRIVATETRANSCRIBE_DIAG_DISABLE_CONTROL_PANEL_WINDOW)) {
      const panel = await findWindow(app, (w) => isControlPanelUrl(w.url()), "control panel");
      await panel.waitForLoadState("load");
    }
    if (!isFlagOn(env.PRIVATETRANSCRIBE_DIAG_DISABLE_OVERLAY_WINDOW)) {
      const overlay = await findWindow(
        app,
        (w) => !isControlPanelUrl(w.url()) && w.url().includes("index.html"),
        "dictation overlay"
      );
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

    await use(app);

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

    // Bound the shutdown. If the main process ever blocks on a native dialog,
    // app.close() never resolves and the whole worker dies on a teardown
    // timeout instead of reporting the real failure.
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
  },

  controlPanel: async ({ electronApp, completeOnboarding }, use) => {
    let page = await findWindow(electronApp, (w) => isControlPanelUrl(w.url()), "control panel");

    if (completeOnboarding) {
      const alreadyDone = await page.evaluate(
        () => localStorage.getItem("onboardingCompleted") === "true"
      );
      if (!alreadyDone) {
        // localStorage lives in the renderer's LevelDB store, so it can only be
        // seeded after first paint. Reload to re-run AppRouter's onboarding gate.
        await page.evaluate(() => localStorage.setItem("onboardingCompleted", "true"));
        await page.reload({ waitUntil: "domcontentloaded" });
        page = await findWindow(electronApp, (w) => isControlPanelUrl(w.url()), "control panel");
      }
    }

    await use(page);
  },

  overlayWindow: async ({ electronApp }, use) => {
    const page = await findWindow(
      electronApp,
      (w) => !isControlPanelUrl(w.url()) && w.url().includes("index.html"),
      "dictation overlay"
    );
    await use(page);
  },
});

export { expect };
