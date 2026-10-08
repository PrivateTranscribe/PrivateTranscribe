import { execFile, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { ElectronApplication, Page } from "@playwright/test";
import { expect, test } from "./fixtures/electron-app";

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(__dirname, "..", "..");

/**
 * Ledger gate `readaloud-selection-e2e`: prove the app can read the text a user
 * has selected in a completely different application.
 *
 * REQUIRES AN UNLOCKED, INTERACTIVE DESKTOP. This spec drives the real Windows
 * desktop — it opens Notepad, brings it to the foreground, and injects
 * keystrokes into it. On a locked session or a headless agent there is no
 * foreground window to activate and the spec fails loudly rather than skipping,
 * because a skip here would hide the only thing the gate measures.
 *
 * Two things are being proven:
 *
 *   1. Exactness. Whatever the app captures has to equal the file's bytes, not
 *      a plausible-looking approximation. Three runs, so a single lucky one
 *      cannot pass it.
 *   2. The modifier-release guard. A read hotkey is a chord, so its modifiers
 *      are still physically held when the read fires, and a Ctrl+C injected at
 *      that moment arrives as Ctrl+<modifiers>+C and copies nothing — silently.
 *      Run 4 holds Ctrl across the capture and asserts both that the text still
 *      came back and that the worker actually spent time waiting for release.
 *
 * The held modifier is produced by `windows-hold-key.exe`, a native SendInput
 * helper already in the repo. It cannot be done from PowerShell: keybd_event
 * plus GetAsyncKeyState is a textbook keylogger signature and Defender's AMSI
 * blocks any script containing it. (The spec's own automation is likewise
 * restricted to managed APIs — SendKeys and WScript.Shell.AppActivate.)
 */

/**
 * The known content, written to disk verbatim and expected back verbatim.
 *
 * Deliberately not single-line ASCII: the interesting failure modes are CRLF
 * normalisation and non-ASCII mangling, and content that cannot express them
 * would pass while the feature was broken. Measured on Windows 11 Notepad, the
 * clipboard round-trips both exactly — CR LF stays CR LF, and there is no
 * trailing newline added. The file is written without one so equality is
 * literal on both sides.
 *
 * It must also read as English to the Read Aloud language guard
 * (readAloudLanguageGuard.js), or the app sends a non-English notice instead of
 * speaking it and the overlay never sees the text. The earlier, shorter text
 * scored as Finnish because åäö weighed too much against so few English words.
 * This one scores en=0.91, fi=0.02 with tinyld 1.3.4.
 */
const KNOWN_CONTENT =
  "Read Aloud should capture this selected text from Notepad exactly as it was written.\r\n" +
  "The second line includes a few accented letters, åäö, and the number 1234.";

/** Set before every capture; the capture must put it back afterwards. */
const CLIPBOARD_MARKER = "pre-existing clipboard content";

/** How long Ctrl stays down across the run-4 capture. */
const MODIFIER_HOLD_MS = 600;

const HOLD_KEY_EXE = path.join(REPO_ROOT, "resources", "bin", "windows-hold-key.exe");

type CaptureResult = {
  text: string;
  source: string;
  waitedMs: number | null;
  detail: string;
};

/**
 * Run a PowerShell script from a temp file.
 *
 * `-File` rather than `-Command` because a script passed on the command line
 * has to survive two layers of quoting; a file has none of that. Everything
 * here uses managed APIs only.
 */
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

/**
 * Open Notepad on `file` and return the pid of the process that owns the
 * window, plus every notepad pid the launch created.
 *
 * Neither is obvious on Windows 11. `notepad.exe` is a stub that relaunches the
 * packaged app and exits, so the pid Start-Process reports never owns a window;
 * and Notepad is tabbed, so the file may open as a tab inside a process that
 * already existed. The window is therefore found by title, and cleanup only
 * touches pids that were not running before the launch.
 */
async function openNotepad(file: string): Promise<{ hostPid: number; ourPids: number[] }> {
  const title = path.basename(file, ".txt");
  const stdout = await powershell(`
$ErrorActionPreference = "Stop"
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
if (-not $owner) {
  Write-Output "HOST_PID="
  Write-Output ("ALL=" + ((Get-Process notepad -ErrorAction SilentlyContinue | ForEach-Object { "$($_.Id):$($_.MainWindowTitle)" }) -join " | "))
  exit 0
}

$after = @(Get-Process notepad -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
$ours = @($after | Where-Object { $before -notcontains $_ })
if ($ours -notcontains $launched.Id) { $ours += $launched.Id }
Write-Output ("HOST_PID=" + $owner.Id)
Write-Output ("OUR_PIDS=" + ($ours -join ","))
`);

  const hostPid = Number(readLine(stdout, "HOST_PID"));
  if (!hostPid) {
    throw new Error(
      `Notepad never produced a window titled "${title}". This spec needs an unlocked, ` +
        `interactive desktop. Notepad processes seen: ${readLine(stdout, "ALL") || "(none)"}`
    );
  }
  const ourPids = (readLine(stdout, "OUR_PIDS") || "")
    .split(",")
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isFinite(value) && value > 0);

  return { hostPid, ourPids };
}

/**
 * Put Notepad in the exact state a capture needs: foreground, everything
 * selected, and the marker sitting on the clipboard. Verified, not assumed.
 *
 * Two hard-won details:
 *
 *   - `AppActivate` returns true when it *found* the window, not when it won
 *     the foreground. Windows only lets a process call SetForegroundWindow if
 *     it owns the last input event, so a browser sitting in front simply keeps
 *     it. Sending a bare ALT first is the standard way to claim that right; a
 *     run without it captured a Pinterest page instead of the file.
 *   - Success is confirmed by copying the selection with the spec's own
 *     SendKeys and checking it against the file. That is a precondition check,
 *     not the assertion: the graded capture goes through the app's IPC path, a
 *     separate PowerShell worker, the sentinel, the modifier wait, and the
 *     clipboard restore, none of which this touches.
 *
 * Everything happens in one PowerShell process so nothing runs between winning
 * the foreground and handing control back.
 */
async function prepareNotepad(hostPid: number, expected: string): Promise<void> {
  // Passed as base64: the script file is written without a BOM and Windows
  // PowerShell would read non-ASCII in it as ANSI.
  const expectedB64 = Buffer.from(expected, "utf8").toString("base64");
  const markerB64 = Buffer.from(CLIPBOARD_MARKER, "utf8").toString("base64");

  const stdout = await powershell(`
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Windows.Forms
$expected = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("${expectedB64}"))
$marker = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("${markerB64}"))
$shell = New-Object -ComObject WScript.Shell
$ready = $false
$probe = ""
for ($attempt = 0; $attempt -lt 8; $attempt++) {
  if ($attempt -gt 0) {
    # Anything else on the desktop that types while Notepad has the foreground
    # edits the file under us, and every later attempt would then compare
    # against corrupted text. Undo first; with nothing to undo this is a no-op.
    for ($u = 0; $u -lt 5; $u++) { [System.Windows.Forms.SendKeys]::SendWait("^z") }
    Start-Sleep -Milliseconds 200
  }
  # A bare ALT makes this process the owner of the last input event, which is
  # what Windows requires before it will honour a foreground change.
  try { $shell.SendKeys("%") } catch {}
  Start-Sleep -Milliseconds 150
  try { [void]$shell.AppActivate(${hostPid}) } catch {}
  Start-Sleep -Milliseconds 500
  # If Notepad already had the foreground, the ALT above put its menu bar into
  # focus, and Ctrl+A there selects nothing. ESC leaves menu mode; in the text
  # area it does nothing.
  [System.Windows.Forms.SendKeys]::SendWait("{ESC}")
  Start-Sleep -Milliseconds 150
  [System.Windows.Forms.SendKeys]::SendWait("^a")
  Start-Sleep -Milliseconds 250
  Set-Clipboard -Value "__pt_probe__"
  Start-Sleep -Milliseconds 150
  [System.Windows.Forms.SendKeys]::SendWait("^c")
  Start-Sleep -Milliseconds 450
  $probe = Get-Clipboard -Raw
  if ($null -eq $probe) { $probe = "" }
  if ($probe -ceq $expected) { $ready = $true; break }
  Start-Sleep -Milliseconds 500
}
Set-Clipboard -Value $marker
# The clipboard is a single-owner global. Letting this process' ownership
# settle before it exits keeps the app's own writeText from racing it.
Start-Sleep -Milliseconds 250
Write-Output ("READY=" + $ready)
Write-Output ("PROBE=" + [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($probe)))
`);

  if (readLine(stdout, "READY") !== "True") {
    const probe = Buffer.from(readLine(stdout, "PROBE") || "", "base64").toString("utf8");
    throw new Error(
      `Could not put Notepad (pid ${hostPid}) in the foreground with its text selected. ` +
        `This spec needs an unlocked, interactive desktop with nothing else grabbing the ` +
        `foreground. Copying the selection produced: ${JSON.stringify(probe.slice(0, 200))}`
    );
  }
}

async function getClipboard(): Promise<string> {
  const stdout = await powershell(`
$ErrorActionPreference = "Stop"
$clip = Get-Clipboard -Raw
if ($null -eq $clip) { $clip = "" }
Write-Output ("CLIP=" + [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($clip)))
`);
  const encoded = readLine(stdout, "CLIP");
  return encoded ? Buffer.from(encoded, "base64").toString("utf8") : "";
}

async function closeNotepad(pids: number[]): Promise<void> {
  if (pids.length === 0) return;
  const list = pids.join(",");
  await powershell(`
foreach ($id in @(${list})) {
  $p = Get-Process -Id $id -ErrorAction SilentlyContinue
  if (-not $p) { continue }
  # Close the window first so Windows 11 Notepad does not resurrect the tab as a
  # restored session next time the user opens it.
  try { [void]$p.CloseMainWindow() } catch {}
}
Start-Sleep -Milliseconds 700
foreach ($id in @(${list})) {
  Stop-Process -Id $id -Force -ErrorAction SilentlyContinue
}
`).catch(() => {
    // Cleanup must never mask the real assertion failure.
  });
}

/** Hold Ctrl down globally until the returned handle is released. */
async function holdControl(): Promise<{ release: () => Promise<void> }> {
  const child: ChildProcess = spawn(HOLD_KEY_EXE, ["--key=Ctrl", "--max-ms=10000"], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });

  let released = false;
  const release = async () => {
    if (released) return;
    released = true;
    // Closing stdin is the helper's documented release signal, and every one of
    // its exit paths ends in a key-up, so Ctrl cannot be left logically down.
    try {
      child.stdin?.end();
    } catch {
      // Already gone.
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          // Already gone.
        }
        resolve();
      }, 3000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  };

  const held = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), 5000);
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      if (chunk.includes("held")) {
        clearTimeout(timer);
        resolve(true);
      }
    });
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });

  if (!held) {
    await release();
    throw new Error(`${HOLD_KEY_EXE} never reported the key as held`);
  }

  return { release };
}

/**
 * Keep synthesis out of this spec entirely: mute every window, and point the
 * model cache at an empty directory so the Kokoro weights cannot be found.
 *
 * A successful capture pushes the text to the overlay's player, and the player
 * tries to speak it. Left alone that does two unwanted things. It plays audio
 * out loud on a real developer's desktop, four times. And it loads 326MB of
 * weights and runs onnxruntime in the main process while the next capture is
 * writing the clipboard and talking to its PowerShell worker on a 4s budget — a
 * timing hazard this spec has no reason to take on.
 *
 * `seedKokoroModel` is not used for this because it does the opposite: it makes
 * the model available. Redirecting `home` is what actually removes it, since
 * getModelsDirForService() resolves under it on every call. Sentence splitting
 * needs no model, so the readaloud-speak assertions still prove the text
 * arrived intact; the engine load then fails fast and nothing plays. Muting is
 * belt-and-braces in case a future change puts a model back in reach. Engine
 * behaviour is measured on its own in readaloud-engine.spec.ts.
 */
async function silenceReadAloud(electronApp: ElectronApplication): Promise<void> {
  const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), "pt-e2e-no-models-"));
  await electronApp.evaluate(({ app, BrowserWindow }, dir) => {
    app.setPath("home", dir);
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.setAudioMuted(true);
    }
  }, emptyHome);
}

test.describe.configure({ mode: "serial" });

/**
 * Drop any readaloud-speak events recorded so far, so each graded capture is
 * asserted against its own event and a discarded environment retry cannot leave
 * a stale one behind.
 */
async function resetSpeakEvents(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as any).__seenSpeak = [];
  });
}

/** Wait until the overlay has recorded at least `count` readaloud-speak events. */
async function waitForSpeakEvents(page: Page, count: number): Promise<string[]> {
  return (await page.evaluate(async (want: number) => {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const events = (window as any).__seenSpeak as string[];
      if (events.length >= want || Date.now() > deadline) return events;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }, count)) as string[];
}

test.describe("read aloud selection capture", () => {
  // Four Notepad round-trips plus app boot; UI automation is not fast.
  test.setTimeout(240_000);

  test("captures the exact selection from Notepad, modifiers held or not", async ({
    electronApp,
    overlayWindow,
  }) => {
    expect(
      fs.existsSync(HOLD_KEY_EXE),
      `missing ${HOLD_KEY_EXE} — run npm run compile:holdkey`
    ).toBe(true);

    await silenceReadAloud(electronApp);

    // Record every readaloud-speak event the overlay receives. This is the same
    // channel App.jsx's player listens on, so it proves the capture reached the
    // renderer with the text intact.
    await overlayWindow.evaluate(() => {
      (window as any).__seenSpeak = [];
      (window as any).electronAPI.onReadAloudSpeak((_event: unknown, data: { text: string }) => {
        (window as any).__seenSpeak.push(data?.text);
      });
    });

    const file = path.join(os.tmpdir(), `pt-selection-${Date.now()}.txt`);
    // No trailing newline: the assertion is literal equality with these bytes.
    fs.writeFileSync(file, KNOWN_CONTENT, "utf8");

    let notepad: { hostPid: number; ourPids: number[] } | null = null;

    try {
      notepad = await openNotepad(file);

      const capture = async (): Promise<CaptureResult> =>
        (await overlayWindow.evaluate(
          async () => await (window as any).electronAPI.readAloudReadSelection()
        )) as CaptureResult;

      const hostPid = notepad.hostPid;

      /**
       * Prepare, capture, and — when the copy came back empty — work out whose
       * fault that was before letting the assertions run.
       *
       * This is an environment retry, not an assertion retry. A capture that
       * produced text is returned untouched and graded as-is. Only an empty
       * copy triggers the second look, and it re-runs the same verified
       * preparation: if that still succeeds the desktop was fine and the app
       * really did fail, so the result is handed back to fail the assertions.
       * A retry happens only when preparation itself can no longer be met,
       * which means something outside this spec took the foreground or typed
       * into the file — a run that never tested the feature at all.
       *
       * It exists because this machine is a real desktop. Observed
       * contamination during development included another app's dictation being
       * pasted into Notepad mid-run.
       */
      const captureWithEnvironmentGuard = async (label: string): Promise<CaptureResult> => {
        for (let attempt = 1; attempt <= 3; attempt++) {
          await prepareNotepad(hostPid, KNOWN_CONTENT);
          await resetSpeakEvents(overlayWindow);
          const result = await capture();
          if (result.source === "selection") return result;

          let desktopStillHealthy = true;
          try {
            await prepareNotepad(hostPid, KNOWN_CONTENT);
          } catch {
            desktopStillHealthy = false;
          }
          if (desktopStillHealthy) return result;

          console.warn(
            `[e2e] ${label}: something else on the desktop took the foreground during the ` +
              `capture (attempt ${attempt}/3). Retrying — this run tested nothing.`
          );
        }
        throw new Error(
          `${label}: the desktop never stayed quiet long enough to run a capture. Close ` +
            `anything that types or steals focus (including another PrivateTranscribe ` +
            `instance) and run this spec again.`
        );
      };

      // ---- Runs 1-3: the plain path, nothing held. --------------------------
      for (let run = 1; run <= 3; run++) {
        const result = await captureWithEnvironmentGuard(`run ${run}`);

        expect(result.source, `run ${run} capture source (detail: ${result.detail})`).toBe(
          "selection"
        );
        expect(result.text, `run ${run} captured text`).toBe(KNOWN_CONTENT);
        // Nothing was held, so the worker should not have waited at all. This is
        // the control for run 4's assertion that it did.
        expect(result.waitedMs, `run ${run} wait with no modifiers held`).not.toBeNull();
        expect(result.waitedMs as number, `run ${run} wait with no modifiers held`).toBeLessThan(
          50
        );

        expect(await getClipboard(), `run ${run} clipboard was not restored`).toBe(
          CLIPBOARD_MARKER
        );

        const seen = await waitForSpeakEvents(overlayWindow, 1);
        expect(seen, `run ${run}: overlay never received a readaloud-speak event`).toHaveLength(1);
        expect(seen[0], `run ${run}: text delivered to the overlay`).toBe(KNOWN_CONTENT);
      }

      // ---- Run 4: Ctrl physically held across the capture. ------------------
      // Same environment guard as above, inlined because the holder has to be
      // started between the preparation and the capture. Nothing else may run
      // in that gap: the holder injects only a key-down and cannot change the
      // foreground.
      let guarded: CaptureResult | null = null;
      for (let attempt = 1; attempt <= 3; attempt++) {
        await prepareNotepad(notepad.hostPid, KNOWN_CONTENT);
        await resetSpeakEvents(overlayWindow);

        const holder = await holdControl();
        let result: CaptureResult;
        try {
          // Not awaited yet: the capture has to be in flight while Ctrl is
          // down, which is exactly the situation a chorded read hotkey creates.
          const pending = capture();
          await new Promise((resolve) => setTimeout(resolve, MODIFIER_HOLD_MS));
          await holder.release();
          result = await pending;
        } finally {
          await holder.release();
        }

        if (result.source === "selection") {
          guarded = result;
          break;
        }

        let desktopStillHealthy = true;
        try {
          await prepareNotepad(notepad.hostPid, KNOWN_CONTENT);
        } catch {
          desktopStillHealthy = false;
        }
        if (desktopStillHealthy) {
          guarded = result;
          break;
        }

        console.warn(
          `[e2e] held-modifier run: the desktop lost the foreground during the capture ` +
            `(attempt ${attempt}/3). Retrying — this run tested nothing.`
        );
      }

      if (!guarded) {
        throw new Error(
          "held-modifier run: the desktop never stayed quiet long enough to run a capture."
        );
      }

      expect(guarded.source, `held-modifier capture source (detail: ${guarded.detail})`).toBe(
        "selection"
      );
      expect(guarded.text, "held-modifier captured text").toBe(KNOWN_CONTENT);
      expect(guarded.waitedMs, "held-modifier capture reported no wait").not.toBeNull();
      // > 0 proves the worker really deferred the keystroke rather than getting
      // lucky; < 2000 proves it did not simply exhaust its safety cap and fire
      // with the modifier still down.
      expect(guarded.waitedMs as number, "held-modifier wait").toBeGreaterThan(0);
      expect(guarded.waitedMs as number, "held-modifier wait hit the 2s cap").toBeLessThan(2000);

      expect(await getClipboard(), "clipboard was not restored after the held-modifier run").toBe(
        CLIPBOARD_MARKER
      );

      const seenHeld = await waitForSpeakEvents(overlayWindow, 1);
      expect(seenHeld, "held-modifier run produced no readaloud-speak event").toHaveLength(1);
      expect(seenHeld[0], "held-modifier text delivered to the overlay").toBe(KNOWN_CONTENT);

      // Single line so the ledger's numbers can be read straight from the runner.
      console.log(`SELECTION_WAITED_MS_HELD=${guarded.waitedMs}`);
    } finally {
      if (notepad) await closeNotepad(notepad.ourPids);
      fs.rmSync(file, { force: true });
    }
  });
});
