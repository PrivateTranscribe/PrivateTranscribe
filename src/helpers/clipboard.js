const { clipboard, app } = require("electron");
const { spawn, spawnSync } = require("child_process");
const { killProcess } = require("../utils/process");
const debugLogger = require("./debugLogger");
const {
  assertWindowsFastPasteSucceeded,
  PASTE_EVIDENCE_ABSENT,
  getWindowsPasteShortcut,
  resolveWindowsFastPasteExecutable,
} = require("./windowsPasteTarget");

// Cache TTL constants - these mirror CACHE_CONFIG.AVAILABILITY_CHECK_TTL in src/config/constants.ts
const CACHE_TTL_MS = 30000;

const getLinuxDesktopEnv = () =>
  [process.env.XDG_CURRENT_DESKTOP, process.env.XDG_SESSION_DESKTOP, process.env.DESKTOP_SESSION]
    .filter(Boolean)
    .join(":")
    .toLowerCase();

const isGnomeDesktop = (desktopEnv) => desktopEnv.includes("gnome");

const getLinuxSessionInfo = () => {
  const isWayland =
    (process.env.XDG_SESSION_TYPE || "").toLowerCase() === "wayland" ||
    !!process.env.WAYLAND_DISPLAY;
  const xwaylandAvailable = isWayland && !!process.env.DISPLAY;
  const desktopEnv = getLinuxDesktopEnv();
  const isGnome = isWayland && isGnomeDesktop(desktopEnv);

  return { isWayland, xwaylandAvailable, desktopEnv, isGnome };
};

// Platform-specific paste delays (ms before simulating keystroke)
// Each platform has different timing requirements based on their paste mechanism
const PASTE_DELAYS = {
  darwin: 50, // macOS: AppleScript keystroke is async, needs time for clipboard to settle
  win32_fastpaste: 30, // Windows native helper: give clipboard time to sync
  linux: 50, // Linux: Allow time for focus to return to target window on X11
};

// Platform-specific clipboard restoration delays (ms after paste completes)
// Ensures paste is fully processed before restoring original clipboard content
const RESTORE_DELAYS = {
  darwin: 100, // macOS: AppleScript needs time to complete keystroke
  win32_fastpaste: 80, // Windows native helper: allow time for paste processing
  win32_terminal: 250, // Terminal hosts process bracketed paste asynchronously
  linux: 200, // Linux: X11 event queue processing takes longer
};

// Legacy constant for backward compatibility (used by macOS)
const PASTE_DELAY_MS = PASTE_DELAYS.darwin;

class ClipboardManager {
  constructor() {
    this.accessibilityCache = { value: null, expiresAt: 0 };
    this.commandAvailabilityCache = new Map();
    this.fastPastePath = null;
    this.fastPasteChecked = false;
  }

  // Get path to the native fast paste helper (Windows only)
  getFastPastePath() {
    if (this.fastPasteChecked) {
      return this.fastPastePath;
    }

    this.fastPasteChecked = true;

    if (process.platform !== "win32") {
      return null;
    }

    this.fastPastePath = resolveWindowsFastPasteExecutable();
    if (this.fastPastePath) {
      this.safeLog(`✅ Found fast paste helper at: ${this.fastPastePath}`);
    }
    return this.fastPastePath;
  }

  getWindowsPasteStatus() {
    if (process.platform !== "win32") {
      return { available: false, reason: "Not Windows" };
    }
    const fastPastePath = this.getFastPastePath();
    return {
      available: !!fastPastePath,
      path: fastPastePath,
    };
  }

  // Safe logging method - only log in development
  safeLog(...args) {
    if (process.env.NODE_ENV === "development") {
      try {
        console.log(...args);
      } catch (error) {
        // Silently ignore EPIPE errors in logging
        if (error.code !== "EPIPE") {
          process.stderr.write(`Log error: ${error.message}\n`);
        }
      }
    }
  }

  // Check if a command exists on the system (cached).
  // Uses `which` as a separate process argument - never via shell string interpolation -
  // to eliminate any risk of command injection through the cmd value.
  commandExists(cmd) {
    const now = Date.now();
    const cached = this.commandAvailabilityCache.get(cmd);
    if (cached && now < cached.expiresAt) {
      return cached.exists;
    }

    // Allowlist: command names must be simple identifiers (letters, digits, hyphens, underscores).
    // Reject anything that looks like a path or contains shell metacharacters.
    if (!/^[a-zA-Z0-9_-]+$/.test(cmd)) {
      this.commandAvailabilityCache.set(cmd, { exists: false, expiresAt: now + CACHE_TTL_MS });
      return false;
    }

    try {
      // Pass cmd as a distinct argument to `which` - no shell involved.
      const res = spawnSync("which", [cmd], {
        stdio: "ignore",
        timeout: 1000,
        maxBuffer: 1024 * 1024,
      });
      const exists = !res.error && res.status === 0;
      this.commandAvailabilityCache.set(cmd, { exists, expiresAt: now + CACHE_TTL_MS });
      return exists;
    } catch {
      this.commandAvailabilityCache.set(cmd, { exists: false, expiresAt: now + CACHE_TTL_MS });
      return false;
    }
  }

  _snapshotClipboard() {
    // Preserve common clipboard payloads (including images), so auto-paste doesn't destroy
    // whatever the user had (e.g. screenshot/snippet images).
    const text = clipboard.readText();
    const html = clipboard.readHTML();
    const rtf = clipboard.readRTF();
    const image = clipboard.readImage();

    // Note: We intentionally do NOT log clipboard contents (privacy). Only sizes/flags.
    return {
      text,
      html,
      rtf,
      hasImage: image && typeof image.isEmpty === "function" ? !image.isEmpty() : false,
      image,
    };
  }

  _restoreClipboard(snapshot) {
    if (!snapshot) return;

    // clipboard.write overwrites the clipboard in one call, which is important for consistency.
    const payload = {};
    if (typeof snapshot.text === "string" && snapshot.text.length > 0) payload.text = snapshot.text;
    if (typeof snapshot.html === "string" && snapshot.html.length > 0) payload.html = snapshot.html;
    if (typeof snapshot.rtf === "string" && snapshot.rtf.length > 0) payload.rtf = snapshot.rtf;
    if (snapshot.hasImage && snapshot.image) payload.image = snapshot.image;

    try {
      clipboard.write(payload);
    } catch {
      // Last resort: restore at least text.
      try {
        clipboard.writeText(snapshot.text || "");
      } catch {
        // ignore
      }
    }
  }

  _restoreClipboardAfter(snapshot, delayMs) {
    return new Promise((resolve) => {
      setTimeout(() => {
        this._restoreClipboard(snapshot);
        this.safeLog("🔄 Clipboard restored");
        resolve();
      }, delayMs);
    });
  }

  /**
   * @param {string} text
   * @param {{ sendEnter?: boolean }} [options] `sendEnter` presses Enter after
   *   the paste (Agent Mode's spoken "send"). Windows only; the other platforms
   *   paste as before and report `enterSent: false`.
   */
  async pasteText(text, options = {}) {
    const startTime = Date.now();
    const platform = process.platform;
    const sendEnter = options?.sendEnter === true;
    let method = "unknown";
    let deliveryResult = null;

    try {
      // Save original clipboard content first
      const originalClipboard = this._snapshotClipboard();
      this.safeLog(`💾 Saved original clipboard content`, {
        textLength: (originalClipboard.text || "").length,
        htmlLength: (originalClipboard.html || "").length,
        rtfLength: (originalClipboard.rtf || "").length,
        hasImage: !!originalClipboard.hasImage,
      });

      // Copy text to clipboard first - this always works
      clipboard.writeText(text);
      this.safeLog(`📋 Text copied to clipboard (${text.length} chars)`);

      if (platform === "darwin") {
        method = "applescript";
        // Check accessibility permissions first
        this.safeLog("🔍 Checking accessibility permissions for paste operation...");
        const hasPermissions = await this.checkAccessibilityPermissions();

        if (!hasPermissions) {
          this.safeLog("⚠️ No accessibility permissions - text copied to clipboard only");
          const errorMsg =
            "Accessibility permissions required for automatic pasting. Text has been copied to clipboard - please paste manually with Cmd+V.";
          throw new Error(errorMsg);
        }

        this.safeLog("✅ Permissions granted, attempting to paste...");
        await this.pasteMacOS(originalClipboard);
        deliveryResult = { delivered: true, method, enterSent: false };
      } else if (platform === "win32") {
        method = "windows-fast-paste";
        deliveryResult = await this.pasteWindows(originalClipboard, { sendEnter });
      } else {
        method = "linux-tools";
        await this.pasteLinux(originalClipboard);
        deliveryResult = { delivered: true, method, enterSent: false };
      }

      // Log successful paste operation timing
      this.safeLog("✅ Paste operation complete", {
        platform,
        method,
        elapsedMs: Date.now() - startTime,
        textLength: text.length,
        sendEnter,
        enterSent: deliveryResult?.enterSent === true,
      });
      return deliveryResult || { delivered: true, method, enterSent: false };
    } catch (error) {
      this.safeLog("❌ Paste operation failed", {
        platform,
        method,
        elapsedMs: Date.now() - startTime,
        error: error.message,
      });
      throw error;
    }
  }

  async pasteMacOS(originalClipboard) {
    return new Promise((resolve, reject) => {
      setTimeout(() => {
        const pasteProcess = spawn("osascript", [
          "-e",
          'tell application "System Events" to keystroke "v" using command down',
        ]);

        let errorOutput = "";
        let hasTimedOut = false;

        pasteProcess.stderr.on("data", (data) => {
          errorOutput += data.toString();
        });

        pasteProcess.on("close", (code) => {
          if (hasTimedOut) return;

          // Clear timeout first
          clearTimeout(timeoutId);

          // Clean up the process reference
          pasteProcess.removeAllListeners();

          if (code === 0) {
            this.safeLog("✅ Text pasted successfully via Cmd+V simulation");
            setTimeout(() => {
              this._restoreClipboard(originalClipboard);
              this.safeLog("🔄 Original clipboard content restored");
            }, 100);
            resolve();
          } else {
            const errorMsg = `Paste failed (code ${code}). Text is copied to clipboard - please paste manually with Cmd+V.`;
            reject(new Error(errorMsg));
          }
        });

        pasteProcess.on("error", (error) => {
          if (hasTimedOut) return;
          clearTimeout(timeoutId);
          pasteProcess.removeAllListeners();
          const errorMsg = `Paste command failed: ${error.message}. Text is copied to clipboard - please paste manually with Cmd+V.`;
          reject(new Error(errorMsg));
        });

        const timeoutId = setTimeout(() => {
          hasTimedOut = true;
          killProcess(pasteProcess, "SIGKILL");
          pasteProcess.removeAllListeners();
          const errorMsg =
            "Paste operation timed out. Text is copied to clipboard - please paste manually with Cmd+V.";
          reject(new Error(errorMsg));
        }, 3000);
      }, PASTE_DELAY_MS);
    });
  }

  async pasteWindows(originalClipboard, options = {}) {
    // The native helper detects the target window and sends the matching paste
    // chord in one step. It replaced an inline PowerShell probe, which tripped
    // antivirus heuristics because PowerShell submits evaluated script blocks to
    // AMSI for inspection.
    const fastPastePath = this.getFastPastePath();

    if (!fastPastePath) {
      this.safeLog("Windows paste helper not found; keeping text on the clipboard");
      return {
        delivered: false,
        // Nothing was sent, so the text is definitely not in the target field.
        evidence: PASTE_EVIDENCE_ABSENT,
        dispatched: false,
        enterSent: false,
        fallback: "clipboard",
        method: "windows-fast-paste",
      };
    }

    try {
      return await this.pasteWithFastPaste(fastPastePath, originalClipboard, options);
    } catch (error) {
      const notConfirmed = error?.code === "WINDOWS_PASTE_NOT_CONFIRMED";
      this.safeLog(
        notConfirmed
          ? "Windows paste was dispatched but not confirmed; keeping text on the clipboard"
          : "Windows paste helper failed; keeping text on the clipboard",
        notConfirmed ? { dispatched: error.dispatched === true } : { error: error.message }
      );
      return {
        delivered: false,
        // A helper that could not read the target reports "none", and the app
        // must then stay quiet rather than claim a paste failure it cannot see.
        evidence: notConfirmed ? error.evidence : PASTE_EVIDENCE_ABSENT,
        dispatched: notConfirmed && error.dispatched === true,
        // An unobservable target (evidence "none") still gets its Enter, so a
        // terminal that could not be read reports what the helper actually did.
        enterSent: notConfirmed && error.enterSent === true,
        fallback: "clipboard",
        method: "windows-fast-paste",
      };
    }
  }

  async pasteWithFastPaste(fastPastePath, originalClipboard, options = {}) {
    return new Promise((resolve, reject) => {
      const pasteDelay = PASTE_DELAYS.win32_fastpaste;
      const helperArgs = options?.sendEnter === true ? ["--send-enter"] : [];

      setTimeout(() => {
        let hasTimedOut = false;
        let stdout = "";
        let stderr = "";
        const startTime = Date.now();

        this.safeLog(`⚡ Fast paste starting (delay: ${pasteDelay}ms)`, { helperArgs });

        let pasteProcess;
        try {
          pasteProcess = this._spawnFastPaste(fastPastePath, helperArgs);
        } catch (error) {
          reject(new Error(`Fast paste helper could not start: ${error.message}`));
          return;
        }

        pasteProcess.stdout?.on("data", (data) => {
          if (stdout.length < 4096) stdout += data.toString();
        });

        pasteProcess.stderr?.on("data", (data) => {
          if (stderr.length < 4096) stderr += data.toString();
        });

        pasteProcess.on("close", (code) => {
          if (hasTimedOut) return;
          clearTimeout(timeoutId);

          const elapsed = Date.now() - startTime;

          if (code !== 0) {
            reject(
              new Error(
                `Fast paste helper exited with code ${code}${stderr ? `: ${stderr.trim()}` : ""}`
              )
            );
            return;
          }

          let result;
          try {
            result = assertWindowsFastPasteSucceeded(stdout);
          } catch (error) {
            reject(error);
            return;
          }
          const restoreDelay = result.isTerminal
            ? RESTORE_DELAYS.win32_terminal
            : RESTORE_DELAYS.win32_fastpaste;

          this.safeLog(`✅ Fast paste success`, {
            elapsedMs: elapsed,
            isTerminal: result.isTerminal,
            windowClass: result.windowClass || "unknown",
            processName: result.processName || "unknown",
            restoreDelayMs: restoreDelay,
            enterSent: result.enterSent,
          });

          this._restoreClipboardAfter(originalClipboard, restoreDelay).then(() =>
            resolve({
              delivered: true,
              method: "windows-fast-paste",
              enterSent: result.enterSent === true,
            })
          );
        });

        pasteProcess.on("error", (error) => {
          if (hasTimedOut) return;
          clearTimeout(timeoutId);
          reject(new Error(`Fast paste helper failed: ${error.message}`));
        });

        const timeoutId = setTimeout(() => {
          hasTimedOut = true;
          killProcess(pasteProcess, "SIGKILL");
          pasteProcess.removeAllListeners();
          reject(new Error("Fast paste helper timed out"));
        }, 2500);
      }, pasteDelay);
    });
  }

  _spawnFastPaste(fastPastePath, args = []) {
    return spawn(fastPastePath, args, { windowsHide: true });
  }

  async pasteLinux(originalClipboard) {
    const { isWayland, xwaylandAvailable, isGnome } = getLinuxSessionInfo();
    const xdotoolExists = this.commandExists("xdotool");
    const wtypeExists = this.commandExists("wtype");
    const ydotoolExists = this.commandExists("ydotool");

    debugLogger.debug(
      "Linux paste environment",
      {
        isWayland,
        xwaylandAvailable,
        isGnome,
        xdotoolExists,
        wtypeExists,
        ydotoolExists,
        display: process.env.DISPLAY,
        waylandDisplay: process.env.WAYLAND_DISPLAY,
        xdgSessionType: process.env.XDG_SESSION_TYPE,
        xdgCurrentDesktop: process.env.XDG_CURRENT_DESKTOP,
      },
      "clipboard"
    );

    // Get the active window ID before any focus changes
    // This is critical for X11 where our window might briefly take focus
    const getXdotoolActiveWindow = () => {
      if (!xdotoolExists || (isWayland && !xwaylandAvailable)) {
        return null;
      }
      try {
        const result = spawnSync("xdotool", ["getactivewindow"], {
          timeout: 2000,
          maxBuffer: 1024 * 1024,
        });
        if (result.status !== 0) {
          return null;
        }
        return result.stdout.toString().trim() || null;
      } catch {
        return null;
      }
    };

    const getXdotoolWindowClass = (windowId) => {
      if (!xdotoolExists || (isWayland && !xwaylandAvailable)) {
        return null;
      }
      try {
        const args = windowId
          ? ["getwindowclassname", windowId]
          : ["getactivewindow", "getwindowclassname"];
        const result = spawnSync("xdotool", args, {
          timeout: 2000,
          maxBuffer: 1024 * 1024,
        });
        if (result.status !== 0) {
          return null;
        }
        const className = result.stdout.toString().toLowerCase().trim();
        return className || null;
      } catch {
        return null;
      }
    };

    // Capture the target window ID before we potentially lose focus
    const targetWindowId = getXdotoolActiveWindow();
    const xdotoolWindowClass = getXdotoolWindowClass(targetWindowId);

    // Detect if the focused window is a terminal emulator
    // Terminals use Ctrl+Shift+V for paste (since Ctrl+V/C are used for process control)
    const isTerminal = () => {
      // Common terminal emulator class names
      const terminalClasses = [
        "konsole",
        "gnome-terminal",
        "terminal",
        "kitty",
        "alacritty",
        "terminator",
        "xterm",
        "urxvt",
        "rxvt",
        "tilix",
        "terminology",
        "wezterm",
        "foot",
        "st",
        "yakuake",
      ];

      if (xdotoolWindowClass) {
        const isTerminalWindow = terminalClasses.some((term) => xdotoolWindowClass.includes(term));
        if (isTerminalWindow) {
          this.safeLog(`🖥️ Terminal detected via xdotool: ${xdotoolWindowClass}`);
        }
        return isTerminalWindow;
      }

      try {
        // Try kdotool for KDE Wayland (if available)
        if (this.commandExists("kdotool")) {
          // First get the active window ID
          const windowIdResult = spawnSync("kdotool", ["getactivewindow"], {
            timeout: 2000,
            maxBuffer: 1024 * 1024,
          });
          if (windowIdResult.status === 0) {
            const windowId = windowIdResult.stdout.toString().trim();
            // Then get the window class name
            const classResult = spawnSync("kdotool", ["getwindowclassname", windowId], {
              timeout: 2000,
              maxBuffer: 1024 * 1024,
            });
            if (classResult.status === 0) {
              const className = classResult.stdout.toString().toLowerCase().trim();
              const isTerminalWindow = terminalClasses.some((term) => className.includes(term));
              if (isTerminalWindow) {
                this.safeLog(`🖥️ Terminal detected via kdotool: ${className}`);
              }
              return isTerminalWindow;
            }
          }
        }
      } catch (error) {
        // Silent fallback - if detection fails, assume non-terminal
      }
      return false;
    };

    const inTerminal = isTerminal();
    const pasteKeys = inTerminal ? "ctrl+shift+v" : "ctrl+v";

    const canUseWtype = isWayland && !isGnome;
    const canUseYdotool = isWayland;
    const canUseXdotool = isWayland ? xwaylandAvailable && xdotoolExists : xdotoolExists;

    // Define paste tools in preference order based on display server
    // For X11, use windowactivate to ensure correct window receives the keystroke
    // This is critical because PrivateTranscribe's window may briefly take focus during transcription
    const xdotoolArgs = targetWindowId
      ? ["windowactivate", "--sync", targetWindowId, "key", pasteKeys]
      : ["key", pasteKeys];

    if (targetWindowId) {
      this.safeLog(
        `🎯 Targeting window ID ${targetWindowId} for paste (class: ${xdotoolWindowClass})`
      );
    }

    // ydotool uses key codes: 29=LeftCtrl, 42=LeftShift, 47=V
    // Format: keycode:1 (press), keycode:0 (release)
    const ydotoolArgs = inTerminal
      ? ["key", "29:1", "42:1", "47:1", "47:0", "42:0", "29:0"] // Ctrl+Shift+V
      : ["key", "29:1", "47:1", "47:0", "29:0"]; // Ctrl+V

    const candidates = [
      ...(canUseWtype
        ? [
            inTerminal
              ? {
                  cmd: "wtype",
                  args: ["-M", "ctrl", "-M", "shift", "-k", "v", "-m", "shift", "-m", "ctrl"],
                }
              : { cmd: "wtype", args: ["-M", "ctrl", "-k", "v", "-m", "ctrl"] },
          ]
        : []),
      ...(canUseXdotool ? [{ cmd: "xdotool", args: xdotoolArgs }] : []),
      ...(canUseYdotool ? [{ cmd: "ydotool", args: ydotoolArgs }] : []),
    ];

    // Filter to only available tools (this.commandExists is already cached)
    const available = candidates.filter((c) => this.commandExists(c.cmd));

    debugLogger.debug(
      "Available paste tools",
      {
        candidateTools: candidates.map((c) => c.cmd),
        availableTools: available.map((c) => c.cmd),
        targetWindowId,
        xdotoolWindowClass,
        inTerminal,
        pasteKeys,
      },
      "clipboard"
    );

    // Attempt paste with a specific tool
    const pasteWith = (tool) =>
      new Promise((resolve, reject) => {
        // Add small delay on X11 to allow focus to settle
        const delay = isWayland ? 0 : PASTE_DELAYS.linux;

        setTimeout(() => {
          debugLogger.debug(
            "Attempting paste",
            {
              cmd: tool.cmd,
              args: tool.args,
              delay,
              isWayland,
            },
            "clipboard"
          );

          const proc = spawn(tool.cmd, tool.args);
          let stderr = "";
          let stdout = "";

          proc.stderr?.on("data", (data) => {
            stderr += data.toString();
          });

          proc.stdout?.on("data", (data) => {
            stdout += data.toString();
          });

          let timedOut = false;
          const timeoutId = setTimeout(() => {
            timedOut = true;
            killProcess(proc, "SIGKILL");
            debugLogger.warn(
              "Paste tool timed out",
              {
                cmd: tool.cmd,
                timeoutMs: 2000,
              },
              "clipboard"
            );
          }, 2000); // Increased timeout to 2s for windowactivate --sync

          proc.on("close", (code) => {
            if (timedOut) return reject(new Error(`Paste with ${tool.cmd} timed out`));
            clearTimeout(timeoutId);

            if (code === 0) {
              debugLogger.debug("Paste successful", { cmd: tool.cmd }, "clipboard");
              // Restore original clipboard after successful paste
              // Delay allows time for X11 to process paste event before clipboard is overwritten
              setTimeout(() => this._restoreClipboard(originalClipboard), RESTORE_DELAYS.linux);
              resolve();
            } else {
              debugLogger.error(
                "Paste command failed",
                {
                  cmd: tool.cmd,
                  args: tool.args,
                  exitCode: code,
                  stderr: stderr.trim(),
                  stdout: stdout.trim(),
                },
                "clipboard"
              );
              reject(
                new Error(
                  `${tool.cmd} exited with code ${code}${stderr ? `: ${stderr.trim()}` : ""}`
                )
              );
            }
          });

          proc.on("error", (error) => {
            if (timedOut) return;
            clearTimeout(timeoutId);
            debugLogger.error(
              "Paste command spawn error",
              {
                cmd: tool.cmd,
                error: error.message,
                code: error.code,
              },
              "clipboard"
            );
            reject(error);
          });
        }, delay);
      });

    // Try each available tool in order
    const failedAttempts = [];
    for (const tool of available) {
      try {
        await pasteWith(tool);
        this.safeLog(`✅ Paste successful using ${tool.cmd}`);
        debugLogger.info("Paste successful", { tool: tool.cmd }, "clipboard");
        return; // Success!
      } catch (error) {
        const failureInfo = {
          tool: tool.cmd,
          args: tool.args,
          error: error?.message || String(error),
        };
        failedAttempts.push(failureInfo);
        this.safeLog(`⚠️ Paste with ${tool.cmd} failed:`, error?.message || error);
        debugLogger.warn("Paste tool failed, trying next", failureInfo, "clipboard");
        // Continue to next tool
      }
    }

    debugLogger.error("All paste tools failed", { failedAttempts }, "clipboard");

    // Fallback for terminals: use xdotool type to directly input text
    // This bypasses clipboard paste entirely and is more reliable for terminal emulators
    // that may have issues with Ctrl+Shift+V keystroke simulation
    if (inTerminal && xdotoolExists && !isWayland) {
      debugLogger.debug(
        "Trying xdotool type fallback for terminal",
        {
          textLength: clipboard.readText().length,
          targetWindowId,
        },
        "clipboard"
      );
      this.safeLog("🔄 Trying xdotool type fallback for terminal...");
      const textToType = clipboard.readText(); // Read what we put in clipboard
      const typeArgs = targetWindowId
        ? ["windowactivate", "--sync", targetWindowId, "type", "--clearmodifiers", "--", textToType]
        : ["type", "--clearmodifiers", "--", textToType];

      try {
        await pasteWith({ cmd: "xdotool", args: typeArgs });
        this.safeLog("✅ Paste successful using xdotool type fallback");
        debugLogger.info("Terminal paste successful via xdotool type", {}, "clipboard");
        return;
      } catch (error) {
        const fallbackFailure = {
          tool: "xdotool type",
          args: typeArgs,
          error: error?.message || String(error),
        };
        failedAttempts.push(fallbackFailure);
        this.safeLog(`⚠️ xdotool type fallback failed:`, error?.message || error);
        debugLogger.warn("xdotool type fallback failed", fallbackFailure, "clipboard");
      }
    }

    // All tools failed - create specific error for renderer to handle
    const failureSummary =
      failedAttempts.length > 0
        ? `\n\nAttempted tools: ${failedAttempts.map((f) => `${f.tool} (${f.error})`).join(", ")}`
        : "";

    let errorMsg;
    if (isWayland) {
      if (isGnome) {
        if (!xwaylandAvailable) {
          errorMsg =
            "Clipboard copied, but GNOME Wayland blocks automatic pasting. Please paste manually with Ctrl+V.";
        } else if (!xdotoolExists) {
          errorMsg =
            "Clipboard copied, but automatic pasting on GNOME Wayland requires xdotool for XWayland apps. Please install xdotool or paste manually with Ctrl+V.";
        } else if (!xdotoolWindowClass) {
          errorMsg =
            "Clipboard copied, but the active app isn't running under XWayland. Please paste manually with Ctrl+V.";
        } else {
          errorMsg =
            "Clipboard copied, but paste simulation failed via XWayland. Please paste manually with Ctrl+V.";
        }
      } else if (!wtypeExists && !xdotoolExists) {
        if (!xwaylandAvailable) {
          errorMsg =
            "Clipboard copied, but automatic pasting on Wayland requires wtype or xdotool. Please install one or paste manually with Ctrl+V.";
        } else {
          errorMsg =
            "Clipboard copied, but automatic pasting on Wayland requires xdotool (recommended for Electron/XWayland apps) or wtype. Please install one or paste manually with Ctrl+V.";
        }
      } else {
        const xdotoolNote =
          xwaylandAvailable && !xdotoolExists
            ? " Consider installing xdotool, which works well with Electron apps running under XWayland."
            : "";
        errorMsg =
          "Clipboard copied, but paste simulation failed on Wayland. Your compositor may not support the virtual keyboard protocol." +
          xdotoolNote +
          " Alternatively, paste manually with Ctrl+V.";
      }
    } else {
      errorMsg =
        "Clipboard copied, but paste simulation failed on X11. Please install xdotool or paste manually with Ctrl+V.";
    }

    const err = new Error(errorMsg + failureSummary);
    err.code = "PASTE_SIMULATION_FAILED";
    err.failedAttempts = failedAttempts;
    debugLogger.error(
      "Throwing paste simulation failed error",
      {
        errorMsg,
        failedAttempts,
        isWayland,
        isGnome,
      },
      "clipboard"
    );
    throw err;
  }

  async checkAccessibilityPermissions() {
    if (process.platform !== "darwin") return true;

    const now = Date.now();
    if (now < this.accessibilityCache.expiresAt && this.accessibilityCache.value !== null) {
      return this.accessibilityCache.value;
    }

    return new Promise((resolve) => {
      // Check accessibility permissions

      const testProcess = spawn("osascript", [
        "-e",
        'tell application "System Events" to get name of first process',
      ]);

      let testOutput = "";
      let testError = "";

      testProcess.stdout.on("data", (data) => {
        testOutput += data.toString();
      });

      testProcess.stderr.on("data", (data) => {
        testError += data.toString();
      });

      testProcess.on("close", (code) => {
        const allowed = code === 0;
        this.accessibilityCache = {
          value: allowed,
          expiresAt: Date.now() + CACHE_TTL_MS,
        };
        if (!allowed) {
          this.showAccessibilityDialog(testError);
        }
        resolve(allowed);
      });

      testProcess.on("error", (error) => {
        this.accessibilityCache = {
          value: false,
          expiresAt: Date.now() + CACHE_TTL_MS,
        };
        resolve(false);
      });
    });
  }

  showAccessibilityDialog(testError) {
    const isStuckPermission =
      testError.includes("not allowed assistive access") ||
      testError.includes("(-1719)") ||
      testError.includes("(-25006)");

    let dialogMessage;
    if (isStuckPermission) {
      dialogMessage = `🔒 PrivateTranscribe needs Accessibility permissions, but it looks like you may have OLD PERMISSIONS from a previous version.

❗ COMMON ISSUE: If you've rebuilt/reinstalled PrivateTranscribe, the old permissions may be "stuck" and preventing new ones.

🔧 To fix this:
1. Open System Settings → Privacy & Security → Accessibility
2. Look for ANY old "PrivateTranscribe" entries and REMOVE them (click the - button)
3. Also remove any entries that say "Electron" or have unclear names
4. Click the + button and manually add the NEW PrivateTranscribe app
5. Make sure the checkbox is enabled
6. Restart PrivateTranscribe

⚠️ This is especially common during development when rebuilding the app.

📝 Without this permission, text will only copy to clipboard (no automatic pasting).

Would you like to open System Settings now?`;
    } else {
      dialogMessage = `🔒 PrivateTranscribe needs Accessibility permissions to paste text into other applications.

📋 Current status: Clipboard copy works, but pasting (Cmd+V simulation) fails.

🔧 To fix this:
1. Open System Settings (or System Preferences on older macOS)
2. Go to Privacy & Security → Accessibility
3. Click the lock icon and enter your password
4. Add PrivateTranscribe to the list and check the box
5. Restart PrivateTranscribe

⚠️ Without this permission, dictated text will only be copied to clipboard but won't paste automatically.

💡 In production builds, this permission is required for full functionality.

Would you like to open System Settings now?`;
    }

    const permissionDialog = spawn("osascript", [
      "-e",
      `display dialog "${dialogMessage}" buttons {"Cancel", "Open System Settings"} default button "Open System Settings"`,
    ]);

    permissionDialog.on("close", (dialogCode) => {
      if (dialogCode === 0) {
        this.openSystemSettings();
      }
    });

    permissionDialog.on("error", (error) => {
      // Permission dialog error - user will need to manually grant permissions
    });
  }

  openSystemSettings() {
    const settingsCommands = [
      ["open", ["x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"]],
      ["open", ["-b", "com.apple.systempreferences"]],
      ["open", ["/System/Library/PreferencePanes/Security.prefPane"]],
    ];

    let commandIndex = 0;
    const tryNextCommand = () => {
      if (commandIndex < settingsCommands.length) {
        const [cmd, args] = settingsCommands[commandIndex];
        const settingsProcess = spawn(cmd, args);

        settingsProcess.on("error", (error) => {
          commandIndex++;
          tryNextCommand();
        });

        settingsProcess.on("close", (settingsCode) => {
          if (settingsCode !== 0) {
            commandIndex++;
            tryNextCommand();
          }
        });
      } else {
        // All settings commands failed, try fallback
        spawn("open", ["-a", "System Preferences"]).on("error", () => {
          spawn("open", ["-a", "System Settings"]).on("error", () => {
            // Could not open settings app
          });
        });
      }
    };

    tryNextCommand();
  }

  async readClipboard() {
    try {
      const text = clipboard.readText();
      return text;
    } catch (error) {
      throw error;
    }
  }

  async writeClipboard(text) {
    try {
      clipboard.writeText(text);
      return { success: true };
    } catch (error) {
      throw error;
    }
  }

  /**
   * Check availability of paste tools on the current platform.
   * Returns platform-specific information about paste capability.
   */
  checkPasteTools() {
    const platform = process.platform;

    // macOS uses AppleScript - always available, but needs accessibility permission
    if (platform === "darwin") {
      return {
        platform: "darwin",
        available: true,
        method: "applescript",
        requiresPermission: true,
        tools: [],
      };
    }

    // Windows uses PowerShell SendKeys - always available
    if (platform === "win32") {
      return {
        platform: "win32",
        available: true,
        method: "powershell",
        requiresPermission: false,
        tools: [],
      };
    }

    // Linux - check for available paste tools
    const { isWayland, xwaylandAvailable, isGnome } = getLinuxSessionInfo();

    // Check which tools are available
    const tools = [];
    const canUseWtype = isWayland && !isGnome;
    const canUseYdotool = isWayland;
    const canUseXdotool = !isWayland || xwaylandAvailable;

    if (canUseWtype && this.commandExists("wtype")) {
      tools.push("wtype");
    }
    if (canUseXdotool && this.commandExists("xdotool")) {
      tools.push("xdotool");
    }
    if (canUseYdotool && this.commandExists("ydotool")) {
      tools.push("ydotool");
    }

    const available = tools.length > 0;
    let recommendedInstall;
    if (!available) {
      if (!isWayland) {
        recommendedInstall = "xdotool";
      } else if (isGnome) {
        recommendedInstall = xwaylandAvailable ? "xdotool" : undefined;
      } else {
        recommendedInstall = xwaylandAvailable ? "xdotool" : "wtype or xdotool";
      }
    }

    return {
      platform: "linux",
      available,
      method: available ? tools[0] : null,
      requiresPermission: false,
      isWayland,
      xwaylandAvailable,
      tools,
      recommendedInstall,
    };
  }
}

module.exports = ClipboardManager;
