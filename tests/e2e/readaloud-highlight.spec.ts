import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, test } from "./fixtures/electron-app";

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
async function openNotepadSelected(file: string): Promise<{ pids: number[] }> {
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
  return { pids };
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

    const status = async (): Promise<HighlightStatus> =>
      (await overlayWindow.evaluate(
        async () => await (window as any).electronAPI.readAloudHighlightStatus()
      )) as HighlightStatus;

    const waitForHighlight = async (label: string): Promise<HighlightStatus> => {
      const deadline = Date.now() + 20_000;
      let last: HighlightStatus | null = null;
      while (Date.now() < deadline) {
        last = await status();
        if (last.active && last.bounds) return last;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      throw new Error(`${label}: no highlight appeared. Last status: ${JSON.stringify(last)}`);
    };

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
      await overlayWindow.getByRole("button", { name: "Next sentence" }).click();
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
