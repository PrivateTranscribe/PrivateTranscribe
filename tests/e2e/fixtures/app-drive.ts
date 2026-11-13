import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { ElectronApplication, Page } from "@playwright/test";
import { expect } from "./electron-app";

/**
 * Shared steps for specs that drive a fix through the running app: dictate with
 * the fake microphone, see what the app would have pasted, and reach the
 * main-process objects a fault has to be put into.
 *
 * Nothing here types into, pastes into or copies from the developer's desktop.
 */

export type PasteCall = { text: string };

type DriveGlobals = {
  __ptE2ePastes?: PasteCall[];
  __ptE2eRequire?: (relativePath: string) => any;
  __ptE2eLive?: Record<string, any>;
  __ptE2eLog?: LogLine[];
};

/** `detail` is the start of the line's first extra argument, as JSON. */
export type LogLine = { level: string; message: string; detail: string };

/** The glow the overlay shows only while the microphone is recording. */
export const recordingHalo = (overlay: Page) =>
  overlay.locator('div[aria-hidden="true"][style*="width: 68px"][style*="radial-gradient"]');

/**
 * Record what the app pastes instead of typing it into whatever window is in
 * front, and keep the developer's clipboard out of it.
 */
export async function recordPastes(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ ipcMain }) => {
    const g = globalThis as unknown as DriveGlobals;
    g.__ptE2ePastes = [];
    ipcMain.removeHandler("paste-text");
    ipcMain.handle("paste-text", async (_event, text: string) => {
      g.__ptE2ePastes!.push({ text });
      return { delivered: true, method: "e2e-recorder" };
    });
    ipcMain.removeHandler("write-clipboard");
    ipcMain.handle("write-clipboard", async () => true);
    ipcMain.removeHandler("read-clipboard");
    ipcMain.handle("read-clipboard", async () => "");
  });
}

export async function readPastes(app: ElectronApplication): Promise<PasteCall[]> {
  return app.evaluate(() => (globalThis as unknown as DriveGlobals).__ptE2ePastes ?? []);
}

/** Send the overlay the message the hotkey sends it. */
export function sendToOverlay(
  app: ElectronApplication,
  channel: string,
  ...args: unknown[]
): Promise<void> {
  return app.evaluate(
    ({ BrowserWindow }, payload) => {
      const win = BrowserWindow.getAllWindows().find(
        (w) => !w.isDestroyed() && !w.webContents.getURL().includes("panel=true")
      );
      if (!win) throw new Error("no dictation overlay window");
      win.webContents.send(payload.channel, ...payload.args);
    },
    { channel, args }
  );
}

/** One press of the dictation hotkey in tap mode. */
export const toggleDictation = (app: ElectronApplication) => sendToOverlay(app, "toggle-dictation");

/**
 * Local Whisper dictation on the CPU with the Base model, pasting through the
 * recorder above. `extra` adds or overrides localStorage settings.
 */
export async function configureLocalWhisperDictation(
  overlay: Page,
  extra: Record<string, string> = {}
): Promise<void> {
  await overlay.evaluate((overrides) => {
    const settings: Record<string, string> = {
      useLocalWhisper: "true",
      whisperModel: "base",
      localTranscriptionProvider: "whisper",
      useReasoningModel: "false",
      whisperForceCpu: "true",
      autoPaste: "true",
      copyToClipboard: "false",
      enableCorrectionLearning: "false",
      enablePhraseCorrectionLearning: "false",
      actionEngineEnabled: "false",
      audioFeedback: "false",
      successConfirmation: "false",
      customDictionary: "[]",
      ...overrides,
    };
    for (const [key, value] of Object.entries(settings)) localStorage.setItem(key, value);
  }, extra);
  await overlay.evaluate(() =>
    (window as unknown as { electronAPI: any }).electronAPI.setWhisperForceCpu(true)
  );
  await overlay.reload({ waitUntil: "domcontentloaded" });
  await expect(overlay.getByRole("button", { name: "Dictation overlay" })).toBeVisible();
}

/** The texts in History, newest first. */
export async function historyTexts(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const rows = await (window as unknown as { electronAPI: any }).electronAPI.getTranscriptions(
      50
    );
    return Array.isArray(rows) ? rows.map((row: { text: string }) => row.text) : [];
  });
}

/**
 * Give later main-process evaluates a `require` for the app's own files:
 * `globalThis.__ptE2eRequire("src/helpers/whisperServer.js")`.
 *
 * An evaluated function runs outside module scope, so it has no `require` of
 * its own. The entry point's require is the one that already loaded the app, so
 * it hands back the same module objects the app is running on.
 */
export async function installAppRequire(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ app: electronApp }) => {
    const g = globalThis as unknown as DriveGlobals;
    if (g.__ptE2eRequire) return;
    const mainModule = (process as unknown as { mainModule?: NodeJS.Module }).mainModule;
    const appRequire =
      mainModule?.require?.bind(mainModule) ??
      (globalThis as unknown as { require?: NodeRequire }).require;
    if (typeof appRequire !== "function") {
      throw new Error("no require available in the main process");
    }
    const nodePath = appRequire("node:path");
    g.__ptE2eRequire = (relativePath: string) =>
      appRequire(nodePath.join(electronApp.getAppPath(), relativePath));
    g.__ptE2eLive = {};
  });
}

/**
 * Catch the app's own instance of a class the next time one of its methods
 * runs, and keep it at `globalThis.__ptE2eLive[key]`.
 *
 * The app holds its managers in module-local variables. Wrapping a prototype
 * method reaches the live object without changing a line of the app.
 */
export async function catchInstance(
  app: ElectronApplication,
  options: { key: string; modulePath: string; method: string }
): Promise<void> {
  await installAppRequire(app);
  await app.evaluate((_electron, { key, modulePath, method }) => {
    const g = globalThis as unknown as DriveGlobals;
    const exported = g.__ptE2eRequire!(modulePath);
    const proto = (exported.default ?? exported).prototype;
    const original = proto[method];
    if (typeof original !== "function") {
      throw new Error(`${modulePath} has no method ${method} to catch an instance on`);
    }
    proto[method] = function (this: unknown, ...args: unknown[]) {
      g.__ptE2eLive![key] = this;
      return original.apply(this, args);
    };
  }, options);
}

/**
 * Keep a copy of the lines the main process's own code logs, whatever the log
 * level, so a spec can tell which path the app took. Lines a window sends over
 * to be logged are not in it.
 */
export async function tapMainLog(app: ElectronApplication): Promise<void> {
  await installAppRequire(app);
  await app.evaluate(() => {
    const g = globalThis as unknown as DriveGlobals;
    if (g.__ptE2eLog) return;
    g.__ptE2eLog = [];
    const logger = g.__ptE2eRequire!("src/helpers/debugLogger.js");
    for (const level of ["debug", "info", "warn", "error"]) {
      const original = logger[level].bind(logger);
      logger[level] = (message: unknown, ...rest: unknown[]) => {
        let detail = "";
        try {
          detail = rest.length ? (JSON.stringify(rest[0]) ?? "").slice(0, 400) : "";
        } catch {
          // A value that cannot be shown as JSON is left out.
        }
        g.__ptE2eLog!.push({ level, message: String(message), detail });
        return original(message, ...rest);
      };
    }
  });
}

export async function readMainLog(app: ElectronApplication): Promise<LogLine[]> {
  return app.evaluate(() => (globalThis as unknown as DriveGlobals).__ptE2eLog ?? []);
}

/** Write `source` played `times` times over to `dest`, as one PCM WAV file. */
export function repeatWav(source: string, times: number, dest: string): void {
  const wav = fs.readFileSync(source);
  const dataAt = wav.indexOf(Buffer.from("data"), 12);
  if (dataAt < 0) throw new Error(`${source} has no data chunk`);
  const dataSize = wav.readUInt32LE(dataAt + 4);
  const header = Buffer.from(wav.subarray(0, dataAt + 8));
  const samples = wav.subarray(dataAt + 8, dataAt + 8 + dataSize);
  header.writeUInt32LE(dataSize * times, dataAt + 4);
  header.writeUInt32LE(header.length - 8 + dataSize * times, 4);
  fs.writeFileSync(dest, Buffer.concat([header, ...Array<Buffer>(times).fill(samples)]));
}

/** Where a spec's own engines are started from: this checkout's binaries. */
const OUR_ENGINES_DIR = path.resolve(__dirname, "..", "..", "..", "resources", "bin").toLowerCase();

/**
 * End engine processes a spec left running on purpose, by the pids it read
 * from its own app. A pid is only ended while it is an engine started from this
 * checkout, so the installed app's engine, or any program Windows has handed
 * the number to since, is left alone.
 */
export function endLeftoverEngines(pids: Array<number | null | undefined>): void {
  if (process.platform !== "win32") return;
  for (const pid of new Set(pids)) {
    if (!pid) continue;
    try {
      const executable = execFileSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-Command",
          `(Get-Process -Id ${Number(pid)} -ErrorAction SilentlyContinue).Path`,
        ],
        { encoding: "utf8", windowsHide: true }
      ).trim();
      const isEngine = /^(whisper-server|llama-server)/i.test(path.basename(executable));
      const isOurs = path.resolve(executable).toLowerCase().startsWith(OUR_ENGINES_DIR);
      if (!executable || !isEngine || !isOurs) continue;
      execFileSync("taskkill", ["/PID", String(pid), "/F"], { stdio: "ignore", windowsHide: true });
    } catch {
      // Already gone.
    }
  }
}
