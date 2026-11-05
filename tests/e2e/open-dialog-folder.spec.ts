import os from "node:os";
import path from "node:path";
import { expect, test } from "./fixtures/electron-app";

/**
 * Since Electron 43 a file dialog without a defaultPath opens in Downloads
 * every time. The show-open-dialog handler must hand the folder of the last
 * pick back as defaultPath, and leave a caller's own defaultPath alone.
 *
 * The native dialog is replaced in the main process, so nothing opens on
 * screen; the IPC path from the renderer to the handler is the real one.
 */
test("a file picker reopens in the folder last picked from", async ({
  electronApp,
  controlPanel,
}) => {
  const appsFolder = path.join(os.tmpdir(), "pt-e2e-dialog", "apps");
  const ownFolder = path.join(os.tmpdir(), "pt-e2e-dialog", "own");

  await electronApp.evaluate(
    ({ dialog }, picked) => {
      const seen: Array<string | null> = [];
      (globalThis as any).__openDialogDefaults = seen;
      dialog.showOpenDialog = (async (...args: any[]) => {
        const options = args.length > 1 ? args[1] : args[0];
        seen.push(options?.defaultPath ?? null);
        return { canceled: false, filePaths: [picked] };
      }) as typeof dialog.showOpenDialog;
    },
    path.join(appsFolder, "tool.exe")
  );

  await controlPanel.evaluate(() => window.electronAPI.showOpenDialog?.({ title: "First pick" }));
  await controlPanel.evaluate(() => window.electronAPI.showOpenDialog?.({ title: "Second pick" }));
  await controlPanel.evaluate(
    (defaultPath) => window.electronAPI.showOpenDialog?.({ title: "Own folder", defaultPath }),
    ownFolder
  );

  const defaults = await electronApp.evaluate(() => (globalThis as any).__openDialogDefaults);
  expect(defaults).toEqual([null, appsFolder, ownFolder]);
});
