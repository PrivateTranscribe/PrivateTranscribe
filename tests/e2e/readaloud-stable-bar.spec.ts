import fs from "node:fs";
import path from "node:path";
import { expect, test } from "./fixtures/electron-app";
import { evidenceDir } from "./fixtures/evidence";

const before = process.env.PT_READALOUD_BEFORE === "1";
const evidence = evidenceDir("qa-readaloud-stability");
test.use({ seedKokoroModel: true });

test("read aloud bar stays still across highlight loss, pause and sentence changes", async ({
  electronApp,
  overlayWindow,
}) => {
  test.setTimeout(120_000);
  fs.mkdirSync(evidence, { recursive: true });
  const capture = async (name: string) => {
    await overlayWindow.screenshot({
      path: path.join(evidence, `${before ? "before" : "after"}-${name}.png`),
    });
  };
  await capture("idle");
  await overlayWindow.evaluate(async () => {
    await (window as any).electronAPI.readAloudLoadEngine();
    void (window as any).__readAloudTest.speak(
      "A quiet morning makes room for a little reading. The next sentence keeps your place on the page."
    );
  });
  const bar = overlayWindow.getByTestId("readaloud-overlay-player");
  await expect(bar.getByRole("button", { name: "Pause reading" })).toBeVisible({ timeout: 30000 });
  await capture("playing");
  await bar.getByRole("button", { name: "Pause reading" }).click();
  await expect(bar).toContainText("Paused");
  const initial = await bar.boundingBox();
  await capture("paused");
  for (const active of [true, false, true, false]) {
    await electronApp.evaluate(({ BrowserWindow }, active) => {
      for (const win of BrowserWindow.getAllWindows())
        win.webContents.send("readaloud-highlight", { active });
    }, active);
    if (before) {
      await expect(overlayWindow.getByTestId("readaloud-current-sentence")).toHaveCount(
        active ? 0 : 1
      );
    } else {
      await expect(overlayWindow.getByTestId("readaloud-current-sentence")).toHaveCount(0);
      expect(await bar.boundingBox()).toEqual(initial);
    }
    await capture(active ? "highlighted" : "unavailable");
  }
  await electronApp.evaluate(({ BrowserWindow }) => {
    for (const win of BrowserWindow.getAllWindows())
      win.webContents.send("readaloud-control", { op: "forward" });
  });
  await expect(bar.getByTestId("readaloud-progress")).toHaveAttribute("data-position", "2/2");
  if (!before) expect(await bar.boundingBox()).toEqual(initial);
  await capture("next-line");
  await bar.getByRole("button", { name: "Resume reading" }).click();
  await expect(bar.getByRole("button", { name: "Pause reading" })).toBeVisible();
  if (!before) expect(await bar.boundingBox()).toEqual(initial);
  await bar.getByRole("button", { name: "Stop reading" }).click();
  await expect(bar).toHaveCount(0);
  await capture("stopped");
});
