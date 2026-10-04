import fs from "node:fs";
import path from "node:path";
import type { ElectronApplication, Page } from "@playwright/test";
import { expect, test } from "./fixtures/electron-app";
import { evidenceDir } from "./fixtures/evidence";
import { unlockTesterAccess } from "./fixtures/tester-access";

/**
 * Ledger gate `readaloud-playback-controls`: while a read is running, the
 * overlay has to show WHERE in the text it is and let the listener move around
 * in it — not just count sentences at them.
 *
 * Three things are proven here, all against a real Kokoro synthesis so the
 * player is genuinely mid-read rather than in a mocked state:
 *
 *   1. The capsule's progress follows the current sentence without repeating
 *      the text underneath the controls.
 *   2. Pause and resume work through the capsule's buttons.
 *   3. The `readaloud-control` events skip sentences. That is the whole
 *      keybinding path except the OS hook itself: the main process turns a
 *      press of Ctrl+Alt+Space / Left / Right into exactly one of these
 *      events, and the accelerators themselves are never registered in a test
 *      run (the fixture sets PRIVATETRANSCRIBE_DIAG_DISABLE_GLOBAL_SHORTCUT, on
 *      purpose — a run must never bind a machine-global key).
 */

const EVIDENCE_DIR = evidenceDir("readaloud-playback-controls");
const MIN_SCREENSHOT_BYTES = 1_000;

/** Five sentences, each carrying a word that appears nowhere else in the text. */
const FIVE_SENTENCES = [
  "The first sentence mentions a paddleboat.",
  "The second sentence mentions a lighthouse.",
  "The third sentence mentions a windmill.",
  "The fourth sentence mentions a compass.",
  "The fifth sentence mentions a harbour.",
].join(" ");

const MARKERS = ["paddleboat", "lighthouse", "windmill", "compass", "harbour"];

type ReadAloudState = {
  status: string;
  index: number;
  sentenceCount: number;
  playing: boolean;
  currentSentence: string | null;
  error: string | null;
};

async function captureEvidence(page: Page, fileName: string) {
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  const filePath = path.join(EVIDENCE_DIR, fileName);
  await page.screenshot({ path: filePath, fullPage: true });

  const bytes = fs.statSync(filePath).size;
  expect(bytes, `${fileName} is too small to show anything (${bytes} bytes)`).toBeGreaterThan(
    MIN_SCREENSHOT_BYTES
  );
}

/** Push one of the main process's Read Aloud events straight at the overlay. */
async function sendToOverlay(
  electronApp: ElectronApplication,
  channel: string,
  payload: unknown
): Promise<void> {
  const delivered = await electronApp.evaluate(
    ({ BrowserWindow }, args) => {
      const overlay = BrowserWindow.getAllWindows().find((win) => {
        if (win.isDestroyed()) return false;
        const url = win.webContents.getURL();
        return url.includes("index.html") && !url.includes("panel=true");
      });
      if (!overlay) return false;
      overlay.webContents.send(args.channel, args.payload);
      return true;
    },
    { channel, payload }
  );

  expect(delivered, `no overlay window was available to receive ${channel}`).toBe(true);
}

/** Poll the player until it settles on the wanted cursor position. */
async function waitForState(
  overlayWindow: Page,
  want: { index?: number; playing?: boolean },
  timeoutMs = 15_000
): Promise<ReadAloudState> {
  return await overlayWindow.evaluate(
    async ({ wantIndex, wantPlaying, deadlineMs }) => {
      const surface = (window as any).__readAloudTest;
      const deadline = Date.now() + deadlineMs;
      for (;;) {
        const current = surface.getState();
        const indexOk = wantIndex === null || current.index === wantIndex;
        const playingOk = wantPlaying === null || current.playing === wantPlaying;
        if ((indexOk && playingOk) || current.status === "error" || Date.now() > deadline) {
          return current;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    },
    {
      wantIndex: want.index ?? null,
      wantPlaying: want.playing ?? null,
      deadlineMs: timeoutMs,
    }
  );
}

/** Speak the five-sentence text and return once sentence 0 is audibly playing. */
async function startRead(overlayWindow: Page): Promise<void> {
  await overlayWindow.waitForFunction(() => Boolean((window as any).__readAloudTest), null, {
    timeout: 30_000,
  });

  // Pay the cold model load up front so no assertion's poll window absorbs it.
  const engineStatus = await overlayWindow.evaluate(
    async () => await (window as any).electronAPI.readAloudLoadEngine()
  );
  expect(engineStatus.loaded, `engine failed to load: ${engineStatus.error}`).toBe(true);

  await overlayWindow.evaluate((text) => {
    (window as any).__readAloudTest.speak(text);
  }, FIVE_SENTENCES);

  const initial = await waitForState(overlayWindow, { index: 0, playing: true }, 25_000);
  expect(initial.error, "player errored before the read began").toBeNull();
  expect(initial.playing, "playback never started").toBe(true);
  expect(initial.sentenceCount, "sentence split").toBe(5);
  expect(initial.index, "starting sentence").toBe(0);
}

test.use({ seedKokoroModel: true });

test.describe("read aloud playback controls", () => {
  test.setTimeout(180_000);

  test("the capsule tracks progress, and the skip keys move it", async ({
    electronApp,
    overlayWindow,
  }) => {
    await startRead(overlayWindow);

    const player = overlayWindow.getByTestId("readaloud-overlay-player");
    const sentenceLine = overlayWindow.getByTestId("readaloud-current-sentence");

    await expect(player).toBeVisible();
    await expect(sentenceLine).toHaveCount(0);
    await expect(player.getByTestId("readaloud-progress")).toHaveAttribute("data-position", "1/5");

    await captureEvidence(overlayWindow, "readaloud-playback-controls.png");

    // Pause first: a playing sentence advances on its own clock, and every
    // assertion below is about where a control put the cursor.
    await overlayWindow.getByRole("button", { name: "Pause reading" }).click();
    const paused = await waitForState(overlayWindow, { index: 0, playing: false });
    expect(paused.playing, "pause did not take").toBe(false);
    expect(paused.currentSentence).toContain(MARKERS[0]);

    await captureEvidence(overlayWindow, "readaloud-playback-paused.png");

    // Forward: cursor and the visible sentence move together. Skipping is on
    // the keys (Ctrl+Alt+→), which arrive as this event; the capsule carries
    // no skip buttons of its own.
    await sendToOverlay(electronApp, "readaloud-control", { op: "forward" });
    const forward = await waitForState(overlayWindow, { index: 1, playing: false });
    expect(forward.index, "forward did not advance the cursor").toBe(1);
    expect(forward.currentSentence).toContain(MARKERS[1]);
    await expect(sentenceLine).toHaveCount(0);
    await expect(player.getByTestId("readaloud-progress")).toHaveAttribute("data-position", "2/5");

    // Back: and returns.
    await sendToOverlay(electronApp, "readaloud-control", { op: "back" });
    const back = await waitForState(overlayWindow, { index: 0, playing: false });
    expect(back.index, "back did not move the cursor back").toBe(0);
    expect(back.currentSentence).toContain(MARKERS[0]);
    await expect(player.getByTestId("readaloud-progress")).toHaveAttribute("data-position", "1/5");

    await overlayWindow.evaluate(() => (window as any).__readAloudTest.stop());
  });

  test("readaloud-control events skip and pause the read", async ({
    electronApp,
    overlayWindow,
  }) => {
    await startRead(overlayWindow);

    const sentenceLine = overlayWindow.getByTestId("readaloud-current-sentence");
    await expect(sentenceLine).toHaveCount(0);

    // Exactly what a press of Ctrl+Alt+Right sends.
    await sendToOverlay(electronApp, "readaloud-control", { op: "forward" });
    const forward = await waitForState(overlayWindow, { index: 1, playing: true });
    expect(forward.index, "forward op did not advance the cursor").toBe(1);
    expect(forward.playing, "forward op stopped playback").toBe(true);
    expect(forward.currentSentence).toContain(MARKERS[1]);

    // And what Ctrl+Alt+Space sends.
    await sendToOverlay(electronApp, "readaloud-control", { op: "toggle" });
    const toggled = await waitForState(overlayWindow, { index: 1, playing: false });
    expect(toggled.playing, "toggle op did not pause playback").toBe(false);
    expect(toggled.index, "toggle op moved the cursor").toBe(1);
    await expect(overlayWindow.getByTestId("readaloud-overlay-player")).toContainText("Paused");

    await overlayWindow.evaluate(() => (window as any).__readAloudTest.stop());
  });

  test("the Read Aloud page says what the playback keys are", async ({ controlPanel }) => {
    await unlockTesterAccess(controlPanel);
    await controlPanel.getByRole("button", { name: /^Read Aloud( Beta)?$/ }).click();
    await expect(controlPanel.getByRole("heading", { name: "Read Aloud" })).toBeVisible();

    // A key nobody documents is a key nobody presses. The wording has to name
    // the actual accelerators, not gesture at "playback controls".
    const help = controlPanel.getByTestId("readaloud-playback-shortcuts");
    await expect(
      controlPanel.getByText("Pause and skip shortcuts are active only during a read.")
    ).toBeVisible();
    await expect(help.getByRole("button", { name: "Pause or resume hotkey" })).toContainText(
      "Space"
    );
    await expect(help.getByRole("button", { name: "Previous sentence hotkey" })).toBeVisible();
    await expect(help.getByRole("button", { name: "Next sentence hotkey" })).toBeVisible();

    fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
    const filePath = path.join(EVIDENCE_DIR, "readaloud-playback-keys-help.png");
    await controlPanel.screenshot({ path: filePath, fullPage: true });
    expect(fs.statSync(filePath).size).toBeGreaterThan(MIN_SCREENSHOT_BYTES);
  });
});
