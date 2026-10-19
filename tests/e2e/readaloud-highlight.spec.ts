import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { ElectronApplication, Page } from "@playwright/test";
import { expect, test } from "./fixtures/electron-app";
import { evidenceDir } from "./fixtures/evidence";

/**
 * Ledger gate `readaloud-follow-highlight`: the sentence being read is shown
 * where it lives, in the app it was copied from.
 *
 * Desktop-interactive, like readaloud-selection.spec.ts: it opens Notepad on a
 * known text, selects it, presses Read Aloud through the same IPC the hotkey
 * uses, and then measures two things independently:
 *
 *   1. The app's own report: a highlight window is on screen, click-through,
 *      never focusable, and its bounds are where the app says they are.
 *   2. A second opinion from UI Automation, asked directly by this spec with
 *      no app code in the loop: the rectangle of the sentence in Notepad. The
 *      highlight has to sit on that rectangle, within its padding.
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
 * app's code involved.
 */
async function sentenceRectFromNotepad(sentence: string): Promise<Rect> {
  const encoded = Buffer.from(sentence, "utf8").toString("base64");
  const stdout = await powershell(`
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$text = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("${encoded}"))
$desktop = [System.Windows.Automation.AutomationElement]::RootElement
$winCond = New-Object System.Windows.Automation.PropertyCondition(
  [System.Windows.Automation.AutomationElement]::ClassNameProperty, "Notepad")
$win = $desktop.FindFirst([System.Windows.Automation.TreeScope]::Children, $winCond)
if (-not $win) { Write-Output "RECT="; exit 0 }
$docCond = New-Object System.Windows.Automation.PropertyCondition(
  [System.Windows.Automation.AutomationElement]::IsTextPatternAvailableProperty, $true)
$rect = $null
foreach ($el in $win.FindAll([System.Windows.Automation.TreeScope]::Descendants, $docCond)) {
  try {
    $tp = $el.GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern)
    $hit = $tp.DocumentRange.FindText($text, $false, $true)
    if ($hit) {
      $r = $hit.GetBoundingRectangles()
      if ($r.Count -gt 0) { $rect = $r[0]; break }
    }
  } catch {}
}
if (-not $rect) { Write-Output "RECT="; exit 0 }
Write-Output ("RECT=" + [math]::Round($rect.X) + "," + [math]::Round($rect.Y) + "," + [math]::Round($rect.Width) + "," + [math]::Round($rect.Height))
`);
  const raw = readLine(stdout, "RECT");
  if (!raw) throw new Error(`UI Automation could not locate "${sentence}" in Notepad`);
  const [x, y, w, h] = raw.split(",").map((n) => Number.parseInt(n, 10));
  return { x, y, w, h };
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

function expectHighlightOn(
  bounds: { x: number; y: number; width: number; height: number },
  rect: Rect,
  scale: number,
  label: string
) {
  // The app converts physical pixels to DIPs before sizing its window; the
  // second opinion is in physical pixels, so it is converted the same way.
  const dip = { x: rect.x / scale, y: rect.y / scale, w: rect.w / scale, h: rect.h / scale };
  expect(Math.abs(bounds.x - (dip.x - HIGHLIGHT_PAD)), `${label}: left edge`).toBeLessThanOrEqual(
    TOLERANCE
  );
  expect(Math.abs(bounds.y - (dip.y - HIGHLIGHT_PAD)), `${label}: top edge`).toBeLessThanOrEqual(
    TOLERANCE
  );
  expect(
    Math.abs(bounds.width - (dip.w + HIGHLIGHT_PAD * 2)),
    `${label}: width`
  ).toBeLessThanOrEqual(TOLERANCE * 2);
  expect(
    Math.abs(bounds.height - (dip.h + HIGHLIGHT_PAD * 2)),
    `${label}: height`
  ).toBeLessThanOrEqual(TOLERANCE * 2);
}

test.describe("read aloud in-place highlight", () => {
  test.use({ seedKokoroModel: true });
  test.setTimeout(180_000);

  test("tints the spoken sentence inside Notepad, follows a skip, and leaves on stop", async ({
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
    const waitForHighlight = (label: string) => waitForActiveHighlight(overlayWindow, label);

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
      const first = await waitForHighlight("sentence 1");
      const firstRect = await sentenceRectFromNotepad(SENTENCES[0]);
      expectHighlightOn(first.bounds!, firstRect, scale, "sentence 1");

      // The window the tint lives in must never take a click or the focus.
      const windowFacts = await electronApp.evaluate(({ BrowserWindow }, bounds) => {
        const win = BrowserWindow.getAllWindows().find((w) => {
          if (w.isDestroyed()) return false;
          const b = w.getBounds();
          return b.x === bounds.x && b.y === bounds.y && b.width === bounds.width;
        });
        return win
          ? { found: true, focusable: win.isFocusable(), visible: win.isVisible() }
          : { found: false };
      }, first.bounds!);
      expect(windowFacts.found, "a BrowserWindow sits at the reported bounds").toBe(true);
      expect(windowFacts.focusable, "the highlight window is not focusable").toBe(false);

      // While the sentence is visible where it lives, the overlay does not
      // repeat it.
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
      const secondRect = await sentenceRectFromNotepad(SENTENCES[1]);
      await expect
        .poll(async () => (await status()).bounds?.x ?? null, {
          message: "the highlight moves to the second sentence",
          timeout: 10_000,
        })
        .not.toBe(first.bounds!.x);
      const second = await status();
      expectHighlightOn(second.bounds!, secondRect, scale, "sentence 2");

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
