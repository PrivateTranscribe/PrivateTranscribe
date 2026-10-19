import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { ElectronApplication, Page } from "@playwright/test";
import { expect, test } from "./fixtures/electron-app";
import { evidenceDir } from "./fixtures/evidence";

/**
 * Ledger gate `readaloud-follow-highlight`: the word being read is shown
 * where it lives, in the app it was copied from.
 *
 * Desktop-interactive, like readaloud-selection.spec.ts: it opens Notepad on a
 * known text, selects it, presses Read Aloud through the same IPC the hotkey
 * uses, and then measures two things independently:
 *
 *   1. The app's own report: a highlight window is on screen, click-through,
 *      never focusable, and its bounds are where the app says they are.
 *   2. A second opinion from UI Automation, asked directly by this spec with
 *      no app code in the loop: the rectangles of each sentence in Notepad.
 *      Since 3d3b3a0 the highlight marks one word at a time, so it has to sit
 *      inside the sentence being read, one line high, and move forward
 *      through it as the words are spoken.
 *
 * Then a skip forward moves it to the next sentence, and a stop takes it away.
 *
 * A second test checks the highlight is painted on its source app rather than
 * over everything: a window opened over Notepad hides it, and bringing Notepad
 * back to the front brings it back. That one reads real screen pixels.
 *
 * Playback is real (Kokoro seeded) because the highlight follows the player's
 * `playing` state; every window is muted so nothing is audible.
 */

const execFileAsync = promisify(execFile);

const SENTENCES = [
  "The first sentence mentions a paddleboat.",
  "The second sentence mentions a lighthouse.",
  "The third sentence mentions a windmill.",
];
const KNOWN_CONTENT = SENTENCES.join(" ");

/** Mirrors PAD in src/helpers/readAloudHighlight.js. */
const HIGHLIGHT_PAD = 3;
/** DIP rounding on both sides, plus the pad. */
const TOLERANCE = HIGHLIGHT_PAD + 2;

type Rect = { x: number; y: number; w: number; h: number };
type HighlightStatus = {
  supported: boolean;
  workerReady: boolean;
  anchored: boolean;
  active: boolean;
  bounds: { x: number; y: number; width: number; height: number } | null;
  /** The sentence and word the app is marking. */
  target?: { index: number; sentence: string; start?: number; end?: number } | null;
  sourceWindow?: { hwnd: number; topmost: boolean } | null;
};

async function powershell(script: string): Promise<string> {
  const file = path.join(
    os.tmpdir(),
    `pt-e2e-ps-${Date.now()}-${Math.random().toString(36).slice(2)}.ps1`
  );
  fs.writeFileSync(file, script, "utf8");
  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NoLogo", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", file],
      { windowsHide: true, timeout: 60_000 }
    );
    return stdout;
  } finally {
    fs.rmSync(file, { force: true });
  }
}

function readLine(stdout: string, key: string): string | null {
  const match = new RegExp(`^${key}=(.*)$`, "m").exec(stdout);
  return match ? match[1].trim() : null;
}

/** Open Notepad on `file`, bring it to the front, select everything. */
async function openNotepadSelected(
  file: string
): Promise<{ pids: number[]; owner: number; hwnd: number }> {
  const title = path.basename(file, ".txt");
  const stdout = await powershell(`
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Windows.Forms
$before = @(Get-Process notepad -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
$launched = Start-Process notepad.exe -ArgumentList "\`"${file}\`"" -PassThru
$owner = $null
for ($i = 0; $i -lt 80; $i++) {
  Start-Sleep -Milliseconds 250
  $owner = Get-Process notepad -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -like "*${title}*" } |
    Select-Object -First 1
  if ($owner) { break }
}
if (-not $owner) { Write-Output "READY=False"; exit 0 }
$after = @(Get-Process notepad -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
$ours = @($after | Where-Object { $before -notcontains $_ })
if ($ours -notcontains $launched.Id) { $ours += $launched.Id }
$shell = New-Object -ComObject WScript.Shell
try { $shell.SendKeys("%") } catch {}
Start-Sleep -Milliseconds 150
[void]$shell.AppActivate($owner.Id)
Start-Sleep -Milliseconds 500
[System.Windows.Forms.SendKeys]::SendWait("{ESC}")
Start-Sleep -Milliseconds 150
[System.Windows.Forms.SendKeys]::SendWait("^a")
Start-Sleep -Milliseconds 300
Write-Output "READY=True"
Write-Output ("PIDS=" + ($ours -join ","))
Write-Output ("OWNER=" + $owner.Id)
Write-Output ("HWND=" + $owner.MainWindowHandle)
`);
  if (readLine(stdout, "READY") !== "True") {
    throw new Error(
      "Notepad never produced a window. This spec needs an unlocked, interactive desktop."
    );
  }
  const pids = (readLine(stdout, "PIDS") || "")
    .split(",")
    .map((s) => Number.parseInt(s, 10))
    .filter((n) => Number.isFinite(n));
  return {
    pids,
    owner: Number.parseInt(readLine(stdout, "OWNER") || "0", 10),
    hwnd: Number.parseInt(readLine(stdout, "HWND") || "0", 10),
  };
}

async function closeNotepad(pids: number[]): Promise<void> {
  if (!pids.length) return;
  await powershell(`
foreach ($id in @(${pids.join(",")})) {
  $p = Get-Process -Id $id -ErrorAction SilentlyContinue
  if (-not $p) { continue }
  try { [void]$p.CloseMainWindow() } catch {}
}
Start-Sleep -Milliseconds 700
foreach ($id in @(${pids.join(",")})) { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue }
`).catch(() => {
    // Cleanup must never mask the real assertion failure.
  });
}

/**
 * Bring a window to the front the way a click on it would: by process id, or
 * by the exact title of a window this spec made. The Alt press first is what
 * lets a background process move the foreground at all.
 */
async function activateWindow(target: number | string): Promise<void> {
  const arg = typeof target === "number" ? String(target) : `"${target}"`;
  const stdout = await powershell(`
$shell = New-Object -ComObject WScript.Shell
try { $shell.SendKeys("%") } catch {}
Start-Sleep -Milliseconds 150
Write-Output ("ACTIVATED=" + $shell.AppActivate(${arg}))
`);
  if (readLine(stdout, "ACTIVATED") !== "True") {
    throw new Error(`Could not bring ${target} to the front`);
  }
}

type DipBounds = { x: number; y: number; width: number; height: number };

/**
 * What a user would see. Counts the highlight's mint outline pixels on the
 * real screen inside `bounds`, and returns that part of the screen (plus a
 * margin) as a PNG for the evidence folder. The capture is the composed
 * desktop, so a window drawn over the highlight hides it and the count drops
 * to zero.
 *
 * The outline is #70FFBA at 90%: over Notepad, light or dark, or over its
 * selection, it keeps a green channel far above red. The faint fill, the
 * selection blue and a white window do not.
 */
async function probeScreen(
  electronApp: ElectronApplication,
  bounds: DipBounds,
  margin = 0
): Promise<{ mint: number; png: string }> {
  return electronApp.evaluate(
    async ({ desktopCapturer, screen }, { b, margin }) => {
      const display = screen.getDisplayMatching(b);
      const scale = display.scaleFactor;
      const sources = await desktopCapturer.getSources({
        types: ["screen"],
        thumbnailSize: {
          width: Math.round(display.size.width * scale),
          height: Math.round(display.size.height * scale),
        },
      });
      const source = sources.find((s) => s.display_id === String(display.id)) ?? sources[0];
      const image = source.thumbnail;
      const size = image.getSize();
      const toPixels = (r: { x: number; y: number; width: number; height: number }) => {
        const kx = size.width / display.bounds.width;
        const ky = size.height / display.bounds.height;
        const x = Math.max(0, Math.round((r.x - display.bounds.x) * kx));
        const y = Math.max(0, Math.round((r.y - display.bounds.y) * ky));
        return {
          x,
          y,
          width: Math.max(1, Math.min(size.width - x, Math.round(r.width * kx))),
          height: Math.max(1, Math.min(size.height - y, Math.round(r.height * ky))),
        };
      };
      const pixels = image.crop(toPixels(b)).toBitmap(); // BGRA
      let mint = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        const [blue, green, red] = [pixels[i], pixels[i + 1], pixels[i + 2]];
        if (green > 200 && green - red > 60 && green - blue > 20) mint++;
      }
      const around = {
        x: b.x - margin,
        y: b.y - margin,
        width: b.width + margin * 2,
        height: b.height + margin * 2,
      };
      return { mint, png: image.crop(toPixels(around)).toPNG().toString("base64") };
    },
    { b: bounds, margin }
  );
}

/**
 * The second opinion: where does Notepad itself say this sentence is? Asked
 * through UI Automation by this spec, in physical pixels, with none of the
 * app's code involved. One rectangle per line the sentence covers, so a
 * narrow Notepad that wraps it still measures every word.
 */
async function sentenceLinesFromNotepad(sentence: string): Promise<Rect[]> {
  const encoded = Buffer.from(sentence, "utf8").toString("base64");
  const stdout = await powershell(`
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$text = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("${encoded}"))
$desktop = [System.Windows.Automation.AutomationElement]::RootElement
$winCond = New-Object System.Windows.Automation.PropertyCondition(
  [System.Windows.Automation.AutomationElement]::ClassNameProperty, "Notepad")
$docCond = New-Object System.Windows.Automation.PropertyCondition(
  [System.Windows.Automation.AutomationElement]::IsTextPatternAvailableProperty, $true)
$rects = @()
# Every Notepad window, not the first: another one may already be open.
foreach ($win in $desktop.FindAll([System.Windows.Automation.TreeScope]::Children, $winCond)) {
  foreach ($el in $win.FindAll([System.Windows.Automation.TreeScope]::Descendants, $docCond)) {
    try {
      $tp = $el.GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern)
      $hit = $tp.DocumentRange.FindText($text, $false, $true)
      if ($hit) { $rects = @($hit.GetBoundingRectangles()) }
    } catch {}
    if ($rects.Count -gt 0) { break }
  }
  if ($rects.Count -gt 0) { break }
}
$lines = foreach ($r in $rects) {
  "{0},{1},{2},{3}" -f [math]::Round($r.X), [math]::Round($r.Y), [math]::Round($r.Width), [math]::Round($r.Height)
}
Write-Output ("RECTS=" + (@($lines) -join ";"))
`);
  const lines = (readLine(stdout, "RECTS") || "")
    .split(";")
    .filter(Boolean)
    .map((line) => {
      const [x, y, w, h] = line.split(",").map((n) => Number.parseInt(n, 10));
      return { x, y, w, h };
    })
    .filter((r) => r.w > 0 && r.h > 0);
  if (!lines.length) throw new Error(`UI Automation could not locate "${sentence}" in Notepad`);
  return lines;
}

async function highlightStatus(overlay: Page): Promise<HighlightStatus> {
  return (await overlay.evaluate(
    async () => await (window as any).electronAPI.readAloudHighlightStatus()
  )) as HighlightStatus;
}

async function waitForActiveHighlight(overlay: Page, label: string): Promise<HighlightStatus> {
  const deadline = Date.now() + 20_000;
  let last: HighlightStatus | null = null;
  while (Date.now() < deadline) {
    last = await highlightStatus(overlay);
    if (last.active && last.bounds) return last;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`${label}: no highlight appeared. Last status: ${JSON.stringify(last)}`);
}

/**
 * The boxes the highlight shows while sentence `index` is spoken, in the
 * order they appear, until it has shown `count` of them or the read moves on
 * to another sentence. One box per word.
 */
async function followWords(overlay: Page, index: number, count: number): Promise<DipBounds[]> {
  const boxes: DipBounds[] = [];
  const deadline = Date.now() + 15_000;
  while (boxes.length < count && Date.now() < deadline) {
    const status = await highlightStatus(overlay);
    if (status.target && status.target.index !== index) break;
    const last = boxes[boxes.length - 1];
    if (
      status.active &&
      status.bounds &&
      (!last || status.bounds.x !== last.x || status.bounds.y !== last.y)
    ) {
      boxes.push(status.bounds);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return boxes;
}

/**
 * The highlight marks one word, so its box has to sit inside one line of the
 * sentence Notepad measured, one line high, within its padding.
 */
function expectWordInSentence(bounds: DipBounds, lines: Rect[], scale: number, label: string) {
  // The app converts physical pixels to DIPs before sizing its window; the
  // second opinion is in physical pixels, so it is converted the same way.
  const dips = lines.map((r) => ({
    x: r.x / scale,
    y: r.y / scale,
    w: r.w / scale,
    h: r.h / scale,
  }));
  // The line the box is on: the one whose top is nearest the box's.
  const offset = (line: { y: number }) => Math.abs(bounds.y - (line.y - HIGHLIGHT_PAD));
  const line = dips.reduce((best, next) => (offset(next) < offset(best) ? next : best));
  expect(offset(line), `${label}: top edge`).toBeLessThanOrEqual(TOLERANCE);
  expect(
    Math.abs(bounds.height - (line.h + HIGHLIGHT_PAD * 2)),
    `${label}: one line high`
  ).toBeLessThanOrEqual(TOLERANCE * 2);
  expect(bounds.x, `${label}: left edge inside the sentence`).toBeGreaterThanOrEqual(
    line.x - HIGHLIGHT_PAD - TOLERANCE
  );
  expect(bounds.x + bounds.width, `${label}: right edge inside the sentence`).toBeLessThanOrEqual(
    line.x + line.w + HIGHLIGHT_PAD + TOLERANCE
  );
}

/** True when `next` comes after `prev` in reading order. */
function readsAfter(prev: DipBounds, next: DipBounds): boolean {
  const sameLine = Math.abs(next.y - prev.y) < prev.height / 2;
  return sameLine ? next.x > prev.x : next.y > prev.y;
}

test.describe("read aloud in-place highlight", () => {
  test.use({ seedKokoroModel: true });
  test.setTimeout(180_000);

  test("marks the spoken word inside Notepad, follows a skip, and leaves on stop", async ({
    electronApp,
    overlayWindow,
  }) => {
    // Real playback, no sound: the highlight follows `playing`, not audio.
    await electronApp.evaluate(({ BrowserWindow }) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.setAudioMuted(true);
      }
    });
    await overlayWindow.waitForFunction(() => Boolean((window as any).__readAloudTest), null, {
      timeout: 30_000,
    });
    const engine = await overlayWindow.evaluate(
      async () => await (window as any).electronAPI.readAloudLoadEngine()
    );
    expect(engine.loaded, `engine failed to load: ${engine.error}`).toBe(true);

    const scale = await electronApp.evaluate(
      ({ screen }) => screen.getPrimaryDisplay().scaleFactor
    );

    const file = path.join(os.tmpdir(), `pt-highlight-${Date.now()}.txt`);
    fs.writeFileSync(file, KNOWN_CONTENT, "utf8");
    let notepad: { pids: number[] } | null = null;

    const status = () => highlightStatus(overlayWindow);

    try {
      notepad = await openNotepadSelected(file);

      const capture = (await overlayWindow.evaluate(
        async () => await (window as any).electronAPI.readAloudReadSelection()
      )) as { text: string; source: string };
      expect(capture.source, "the read must come from the selection").toBe("selection");
      expect(capture.text.trim()).toBe(KNOWN_CONTENT);

      const player = overlayWindow.getByTestId("readaloud-overlay-player");
      await expect(player).toBeVisible({ timeout: 30_000 });
      await expect(player.getByTestId("readaloud-progress")).toHaveAttribute(
        "data-position",
        "1/3",
        { timeout: 30_000 }
      );

      // ------------------------------------------------------- sentence 1
      // Paused as soon as it plays, so the read waits for the highlight's
      // worker to start cold instead of running on into sentence 2. A paused
      // read keeps its word marked.
      const pause = player.getByRole("button", { name: "Pause reading" });
      await expect(pause).toBeVisible({ timeout: 30_000 });
      await pause.click();
      await expect(player).toContainText("Paused");
      const held = await waitForActiveHighlight(overlayWindow, "sentence 1");
      // Measured while the read is held, not between the select and the copy.
      // With these slow calls there, the copy missed Notepad and the read fell
      // back to the clipboard (2026-10-19).
      const firstLines = await sentenceLinesFromNotepad(SENTENCES[0]);
      const secondLines = await sentenceLinesFromNotepad(SENTENCES[1]);
      expect(held.target?.index, "the app marks a word of sentence 1").toBe(0);
      expectWordInSentence(held.bounds!, firstLines, scale, "sentence 1");

      // The window the mark lives in must never take a click or the focus.
      const windowFacts = await electronApp.evaluate(({ BrowserWindow }, bounds) => {
        const win = BrowserWindow.getAllWindows().find((w) => {
          if (w.isDestroyed()) return false;
          const b = w.getBounds();
          return b.x === bounds.x && b.y === bounds.y && b.width === bounds.width;
        });
        return win
          ? { found: true, focusable: win.isFocusable(), visible: win.isVisible() }
          : { found: false };
      }, held.bounds!);
      expect(windowFacts.found, "a BrowserWindow sits at the reported bounds").toBe(true);
      expect(windowFacts.focusable, "the highlight window is not focusable").toBe(false);

      // While the word is marked where it lives, the overlay does not repeat
      // the sentence.
      await expect(overlayWindow.getByTestId("readaloud-current-sentence")).toHaveCount(0);

      // ------------------------------------------------------- sentence 2
      // Exactly what a press of Ctrl+Alt+Right sends the overlay.
      await electronApp.evaluate(({ BrowserWindow }) => {
        const overlay = BrowserWindow.getAllWindows().find((win) => {
          if (win.isDestroyed()) return false;
          const url = win.webContents.getURL();
          return url.includes("index.html") && !url.includes("panel=true");
        });
        overlay?.webContents.send("readaloud-control", { op: "forward" });
      });
      await expect(player.getByTestId("readaloud-progress")).toHaveAttribute(
        "data-position",
        "2/3"
      );
      // Still paused, the mark moves to the first word of sentence 2. Until
      // the app has found that sentence in Notepad, the old box stays put.
      await expect
        .poll(
          async () => {
            const now = await status();
            return (
              now.active &&
              now.target?.index === 1 &&
              (now.bounds?.x !== held.bounds!.x || now.bounds?.y !== held.bounds!.y)
            );
          },
          { message: "the highlight moves to the second sentence", timeout: 10_000 }
        )
        .toBe(true);
      expectWordInSentence((await status()).bounds!, secondLines, scale, "sentence 2");

      // Played on, the mark walks through sentence 2 a word at a time.
      await player.getByRole("button", { name: "Resume reading" }).click();
      const words = await followWords(overlayWindow, 1, 3);
      expect(
        words.length,
        `the highlight moves on as sentence 2 is spoken: ${JSON.stringify(words)}`
      ).toBeGreaterThanOrEqual(3);
      words.forEach((box, i) =>
        expectWordInSentence(box, secondLines, scale, `sentence 2, word ${i + 1}`)
      );
      for (let i = 1; i < words.length; i++) {
        expect(
          readsAfter(words[i - 1], words[i]),
          `sentence 2: word ${i + 1} ${JSON.stringify(words[i])} comes after ${JSON.stringify(words[i - 1])}`
        ).toBe(true);
      }

      // ------------------------------------------------------------- stop
      await overlayWindow.getByRole("button", { name: "Stop reading" }).click();
      await expect(player).toHaveCount(0, { timeout: 10_000 });
      await expect.poll(async () => (await status()).active, { timeout: 10_000 }).toBe(false);
    } finally {
      if (notepad) await closeNotepad(notepad.pids);
      fs.rmSync(file, { force: true });
    }
  });
});

test.describe("read aloud highlight under other windows", () => {
  // The highlight window has to be really on screen for a pixel probe.
  test.use({ seedKokoroModel: true, revealNewWindows: true });
  test.setTimeout(180_000);

  /** PT_HIGHLIGHT_COVER_BEFORE=1 labels the evidence of a run on the old code. */
  const phase = process.env.PT_HIGHLIGHT_COVER_BEFORE === "1" ? "before" : "after";
  const evidence = evidenceDir("qa-readaloud-highlight-cover");
  const COVER_TITLE = "PrivateTranscribe e2e cover";

  test("hides behind a window over its source app and comes back with the app", async ({
    electronApp,
    overlayWindow,
  }) => {
    fs.mkdirSync(evidence, { recursive: true });
    await electronApp.evaluate(({ BrowserWindow }) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.setAudioMuted(true);
      }
    });
    await overlayWindow.waitForFunction(() => Boolean((window as any).__readAloudTest), null, {
      timeout: 30_000,
    });
    const engine = await overlayWindow.evaluate(
      async () => await (window as any).electronAPI.readAloudLoadEngine()
    );
    expect(engine.loaded, `engine failed to load: ${engine.error}`).toBe(true);

    const file = path.join(os.tmpdir(), `pt-highlight-cover-${Date.now()}.txt`);
    fs.writeFileSync(file, KNOWN_CONTENT, "utf8");
    let notepad: { pids: number[]; owner: number; hwnd: number } | null = null;

    const look = async (name: string, bounds: DipBounds) => {
      const { mint, png } = await probeScreen(electronApp, bounds, 90);
      fs.writeFileSync(path.join(evidence, `${phase}-${name}.png`), Buffer.from(png, "base64"));
      return mint;
    };

    try {
      notepad = await openNotepadSelected(file);
      const capture = (await overlayWindow.evaluate(
        async () => await (window as any).electronAPI.readAloudReadSelection()
      )) as { text: string; source: string };
      expect(capture.source, "the read must come from the selection").toBe("selection");

      // Hold the read on one word, so the highlight stays put while it is
      // covered and uncovered.
      const player = overlayWindow.getByTestId("readaloud-overlay-player");
      await expect(player.getByRole("button", { name: "Pause reading" })).toBeVisible({
        timeout: 30_000,
      });
      await waitForActiveHighlight(overlayWindow, "first word");
      await player.getByRole("button", { name: "Pause reading" }).click();
      await expect(player).toContainText("Paused");
      await overlayWindow.waitForTimeout(500);
      const held = await waitForActiveHighlight(overlayWindow, "paused word");
      const bounds = held.bounds!;

      if (phase === "after") {
        // Second opinion on which window it sits on: Notepad's own handle.
        expect(held.sourceWindow?.hwnd, "glued to the Notepad window").toBe(notepad.hwnd);
      }

      // 1. Over its source app, the outline is on screen.
      await expect
        .poll(() => probeScreen(electronApp, bounds).then((p) => p.mint), {
          message: "the highlight is visible over Notepad",
          timeout: 5_000,
        })
        .toBeGreaterThan(20);
      await look("1-over-notepad", bounds);

      // 2. Another window comes to the front over the text, the way a click
      //    on Chrome or on PrivateTranscribe does. It hides the highlight too.
      await electronApp.evaluate(
        ({ BrowserWindow }, { b, title }) => {
          const cover = new BrowserWindow({
            x: b.x - 60,
            y: b.y - 40,
            width: b.width + 120,
            height: b.height + 80,
            title,
            frame: false,
            show: false,
            backgroundColor: "#ffffff",
            skipTaskbar: true,
            resizable: false,
          });
          cover.loadURL(`data:text/html,<title>${encodeURIComponent(title)}</title>`);
          (globalThis as any).__ptE2eCover = cover;
          cover.showInactive();
        },
        { b: bounds, title: COVER_TITLE }
      );
      await activateWindow(COVER_TITLE);
      await overlayWindow.waitForTimeout(400);
      const covered = await look("2-covered", bounds);
      expect(covered, "a window over the source app hides the highlight").toBe(0);

      // 3. Bringing Notepad back to the front brings the highlight with it.
      await activateWindow(notepad.owner);
      await expect
        .poll(() => probeScreen(electronApp, bounds).then((p) => p.mint), {
          message: "the highlight follows Notepad back to the front",
          timeout: 3_000,
        })
        .toBeGreaterThan(20);
      await look("3-notepad-in-front", bounds);

      await player.getByRole("button", { name: "Stop reading" }).click();
      await expect(player).toHaveCount(0, { timeout: 10_000 });
      await expect
        .poll(async () => (await highlightStatus(overlayWindow)).active, { timeout: 10_000 })
        .toBe(false);
    } finally {
      await electronApp
        .evaluate(() => {
          const cover = (globalThis as any).__ptE2eCover;
          if (cover && !cover.isDestroyed()) cover.destroy();
        })
        .catch(() => {});
      if (notepad) await closeNotepad(notepad.pids);
      fs.rmSync(file, { force: true });
    }
  });
});
