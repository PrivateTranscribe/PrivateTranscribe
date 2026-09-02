/**
 * ReadAloudHighlight - shows the sentence being read WHERE it is, in the app
 * it was copied from, instead of only as a line on the overlay.
 *
 * Kristian, 2026-09-02: "it would be way better if it could show on the screen
 * what is being read up ... compared to having the text down at the overlay."
 *
 * How it works, and why it is shaped like this:
 *
 *   1. Windows UI Automation exposes the text of most documents (Chromium
 *      browsers, Office, Notepad, WordPad, anything with a TextPattern) along
 *      with the screen rectangles of any range inside them. A persistent
 *      PowerShell worker (resources/readaloud-highlight-worker.ps1) anchors on
 *      the focused document's selection right after the copy, then answers
 *      "where is this sentence?" with rectangles in ~100ms. Measured 2026-09-02:
 *      Notepad 108ms, Chrome 118ms, Edge 121ms.
 *   2. A transparent, click-through, never-focusable window paints a soft tint
 *      over those rectangles. It is a separate window rather than part of the
 *      overlay because the overlay is a fixed 400x500 box that follows the
 *      dictation button; the sentence can be anywhere on any monitor.
 *   3. The renderer's player owns playback, so it reports each sentence change
 *      up to the main process (`readaloud-sentence`), and the main process
 *      tells the overlay when a highlight is actually on screen
 *      (`readaloud-highlight`), so the overlay can drop its own sentence line
 *      while the text is visible where it lives.
 *
 * Everything fails soft. No worker, no TextPattern, an app that hides its
 * text from accessibility, a sentence that is not found: the read carries on
 * exactly as before, with the sentence on the overlay.
 */
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const { BrowserWindow, screen } = require("electron");
const debugLogger = require("./debugLogger");

const WORKER_FILENAME = "readaloud-highlight-worker.ps1";
const COMMAND_TIMEOUT_MS = 4000;
/** How often the last hit is re-measured while a read plays: the user may scroll. */
const TRACK_INTERVAL_MS = 700;
/** Breathing room around the sentence's rectangles, in DIPs. */
const PAD = 3;

const DISABLE_FLAG = "PRIVATETRANSCRIBE_DIAG_DISABLE_READALOUD_HIGHLIGHT";
/** The player's statuses between a copy and its first spoken word. */
const PREPARING_STATUSES = new Set(["splitting", "loading-engine", "synthesizing"]);

const isFlagEnabled = (name) => {
  const raw = String(process.env[name] || "")
    .trim()
    .toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
};

/**
 * Union of screen rectangles (physical pixels) converted to the DIP bounds a
 * BrowserWindow takes, plus each rectangle relative to those bounds, so the
 * page can paint them. Pure, so it is unit-tested on its own.
 *
 * @param {{x:number,y:number,w:number,h:number}[]} rects
 * @param {(rect:{x:number,y:number,width:number,height:number}) => {x:number,y:number,width:number,height:number}} toDip
 */
function layoutHighlight(rects, toDip) {
  const dips = rects
    .filter((r) => r && r.w > 0 && r.h > 0)
    .map((r) => toDip({ x: r.x, y: r.y, width: r.w, height: r.h }));
  if (!dips.length) return null;

  const left = Math.min(...dips.map((r) => r.x)) - PAD;
  const top = Math.min(...dips.map((r) => r.y)) - PAD;
  const right = Math.max(...dips.map((r) => r.x + r.width)) + PAD;
  const bottom = Math.max(...dips.map((r) => r.y + r.height)) + PAD;

  const bounds = {
    x: Math.floor(left),
    y: Math.floor(top),
    width: Math.max(1, Math.ceil(right - left)),
    height: Math.max(1, Math.ceil(bottom - top)),
  };
  const boxes = dips.map((r) => ({
    x: Math.round(r.x - bounds.x),
    y: Math.round(r.y - bounds.y),
    width: Math.round(r.width),
    height: Math.round(r.height),
  }));
  return { bounds, boxes };
}

/**
 * The page the highlight window shows: nothing but outlined boxes on a
 * transparent ground. Inline, because it is 20 lines and has no reason to be
 * a build artefact. The mark is a 1.5px stroke in the app's primary (#70FFBA)
 * with only a faint fill: the text underneath is usually still the source
 * app's own selection, and a solid tint over selection blue blended to a cyan
 * that made the sentence being spoken the hardest one to read (blind critic,
 * 2026-09-02). The boxes live in their own container - painting into <body>
 * counted the page's <script> as the first box and left the first line of a
 * wrapped sentence unmarked (same review, same day).
 */
const HIGHLIGHT_PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;background:transparent;overflow:hidden;pointer-events:none}
#boxes{position:absolute;inset:0}
.box{position:absolute;border-radius:4px;background:rgba(112,255,186,0.12);
box-shadow:inset 0 0 0 1.5px rgba(112,255,186,0.9),0 0 0 1px rgba(0,0,0,0.18);
transition:left 120ms ease-out,top 120ms ease-out,width 120ms ease-out,height 120ms ease-out}
</style></head><body><div id="boxes"></div><script>
window.__render=function(boxes){
  var host=document.getElementById('boxes');
  while(host.children.length>boxes.length){host.removeChild(host.lastChild);}
  boxes.forEach(function(b,i){
    var el=host.children[i];
    if(!el){el=document.createElement('div');el.className='box';host.appendChild(el);}
    el.style.left=b.x+'px';el.style.top=b.y+'px';el.style.width=b.width+'px';el.style.height=b.height+'px';
  });
};
</script></body></html>`;

class ReadAloudHighlight {
  /**
   * @param {{ onActiveChange?: (active: boolean) => void }} [options]
   *   `onActiveChange` fires when a highlight appears on or leaves the screen,
   *   so the overlay can show or hide its own sentence line.
   */
  constructor(options = {}) {
    this.isSupported = process.platform === "win32" && !isFlagEnabled(DISABLE_FLAG);
    this.onActiveChange =
      typeof options.onActiveChange === "function" ? options.onActiveChange : null;
    this.worker = null;
    this.workerReady = false;
    this.pending = [];
    this.isStopping = false;

    this.window = null;
    this.active = false;
    this.anchored = false;
    this.anchorPromise = null;
    this.lastIndex = -1;
    this.trackTimer = null;
    this.lastLayoutKey = "";
  }

  resolveWorkerScript() {
    const candidates = new Set([path.join(__dirname, "..", "..", "resources", WORKER_FILENAME)]);
    if (process.resourcesPath) {
      [
        path.join(process.resourcesPath, WORKER_FILENAME),
        path.join(process.resourcesPath, "resources", WORKER_FILENAME),
        path.join(process.resourcesPath, "app.asar.unpacked", "resources", WORKER_FILENAME),
      ].forEach((candidate) => candidates.add(candidate));
    }
    for (const candidate of candidates) {
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {
        continue;
      }
    }
    return null;
  }

  /** Spawn the worker. Safe to call repeatedly; a live worker is reused. */
  start() {
    if (!this.isSupported) return false;
    if (this.worker) return true;

    const scriptPath = this.resolveWorkerScript();
    if (!scriptPath) {
      debugLogger.warn("[ReadAloudHighlight] Worker script not found");
      return false;
    }
    this.isStopping = false;

    let child;
    try {
      child = spawn(
        "powershell.exe",
        ["-NoProfile", "-NoLogo", "-ExecutionPolicy", "Bypass", "-File", scriptPath],
        { stdio: ["pipe", "pipe", "pipe"], windowsHide: true }
      );
    } catch (error) {
      debugLogger.error("[ReadAloudHighlight] Failed to spawn worker", { error: error.message });
      return false;
    }

    this.worker = child;
    this.workerReady = false;

    let buffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        if (line === "READY") {
          this.workerReady = true;
          debugLogger.debug("[ReadAloudHighlight] Worker ready");
          continue;
        }
        const resolve = this.pending.shift();
        if (resolve) resolve(line);
      }
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (data) => {
      const message = String(data).trim();
      if (message) {
        debugLogger.warn("[ReadAloudHighlight] Worker stderr", { message: message.slice(0, 300) });
      }
    });

    child.on("error", (error) => {
      if (this.worker !== child) return;
      debugLogger.error("[ReadAloudHighlight] Worker error", { error: error.message });
    });

    child.on("exit", (code, signal) => {
      if (this.worker !== child) return;
      if (!this.isStopping) {
        debugLogger.warn("[ReadAloudHighlight] Worker exited", { code, signal });
      }
      this.worker = null;
      this.workerReady = false;
      while (this.pending.length) this.pending.shift()("ERR worker gone");
    });

    return true;
  }

  /** Stop the worker and drop the window. Called on app quit. */
  stop() {
    this.isStopping = true;
    this.hide();
    if (this.worker) {
      try {
        this.worker.stdin.end();
      } catch {
        // Already closed.
      }
      try {
        this.worker.kill();
      } catch {
        // Already gone.
      }
      this.worker = null;
    }
    this.workerReady = false;
    while (this.pending.length) this.pending.shift()("ERR worker stopped");
    if (this.window && !this.window.isDestroyed()) {
      try {
        this.window.destroy();
      } catch {
        // Already gone.
      }
    }
    this.window = null;
  }

  async waitForReady(timeoutMs = 3000) {
    const deadline = Date.now() + timeoutMs;
    while (!this.workerReady && this.worker && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return this.workerReady;
  }

  /** One line out, one line back. Resolves with the reply, never rejects. */
  send(command) {
    if (!this.worker || !this.workerReady) {
      return Promise.resolve("ERR worker not ready");
    }
    return new Promise((resolve) => {
      let settled = false;
      const once = (line) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(line);
      };
      this.pending.push(once);
      const timer = setTimeout(() => {
        const index = this.pending.indexOf(once);
        if (index >= 0) this.pending.splice(index, 1);
        once("ERR timeout");
      }, COMMAND_TIMEOUT_MS);
      try {
        this.worker.stdin.write(`${command}\n`);
      } catch (error) {
        const index = this.pending.indexOf(once);
        if (index >= 0) this.pending.splice(index, 1);
        once(`ERR ${error.message}`);
      }
    });
  }

  /**
   * Remember where the text that is about to be read lives. Call right after
   * a successful copy, while the source app still has its selection and its
   * focus. Not awaited by the caller: the first `find` waits on it instead, so
   * anchoring never sits in front of the first spoken word.
   */
  anchor() {
    if (!this.isSupported) return Promise.resolve(false);
    this.lastIndex = -1;
    this.anchored = false;
    this.anchorPromise = (async () => {
      if (!this.worker) this.start();
      // A cold worker spends a second or two loading the UI Automation
      // assemblies. Anchoring is off the speaking path, and the user's
      // selection and focus usually outlive that, so this waits it out rather
      // than giving up at the transport default (which it did, silently, on
      // the first read after launch - measured 2026-09-02).
      await this.waitForReady(8000);
      const started = Date.now();
      const reply = await this.send("anchor");
      const ok = reply.startsWith("OK");
      this.anchored = ok;
      debugLogger.debug("[ReadAloudHighlight] anchor", { reply, ms: Date.now() - started });
      return ok;
    })();
    return this.anchorPromise;
  }

  /**
   * The player moved to a sentence. `status` is the player's own word; only a
   * playing or paused read gets a highlight, everything else clears it.
   */
  async onSentence({ status, index, sentence } = {}) {
    if (!this.isSupported) return;
    // Between the copy and the first spoken word the player reports
    // splitting / loading-engine / synthesizing. Those are the read starting,
    // not ending: clearing on them threw the anchor away 400ms after it was
    // made, every time the engine was already warm (2026-09-02).
    if (PREPARING_STATUSES.has(status)) return;
    const reading = status === "playing" || status === "paused";
    if (!reading || typeof sentence !== "string" || !sentence.trim()) {
      this.clear();
      return;
    }
    if (this.anchorPromise) {
      const ok = await this.anchorPromise;
      if (!ok) return;
    } else if (!this.anchored) {
      return;
    }
    if (index === this.lastIndex) return;
    this.lastIndex = index;

    const encoded = Buffer.from(sentence, "utf8").toString("base64");
    const reply = await this.send(`find ${encoded}`);
    // A later sentence may have overtaken this one while the worker was busy.
    if (this.lastIndex !== index) return;
    this.applyReply(reply);
  }

  applyReply(reply) {
    if (reply.startsWith("RECTS ")) {
      let rects = null;
      try {
        rects = JSON.parse(reply.slice(6));
      } catch {
        rects = null;
      }
      if (Array.isArray(rects) && rects.length) {
        this.show(rects);
        this.startTracking();
        return;
      }
    }
    debugLogger.debug("[ReadAloudHighlight] no rectangles", { reply: reply.slice(0, 80) });
    this.hide();
  }

  /** Keep the tint on the sentence when the user scrolls the source app. */
  startTracking() {
    if (this.trackTimer) return;
    this.trackTimer = setInterval(async () => {
      if (!this.active || !this.anchored) return;
      const reply = await this.send("rects");
      if (!this.active) return;
      this.applyReply(reply);
    }, TRACK_INTERVAL_MS);
  }

  stopTracking() {
    if (this.trackTimer) {
      clearInterval(this.trackTimer);
      this.trackTimer = null;
    }
  }

  ensureWindow() {
    if (this.window && !this.window.isDestroyed()) return this.window;
    const win = new BrowserWindow({
      width: 1,
      height: 1,
      show: false,
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      focusable: false,
      skipTaskbar: true,
      hasShadow: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      webPreferences: {
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
      },
    });
    win.setIgnoreMouseEvents(true, { forward: true });
    // Above the source app, whatever it is, and never in front of a real
    // dialog: "screen-saver" is the level the dictation overlay uses too.
    try {
      win.setAlwaysOnTop(true, "screen-saver");
    } catch {
      win.setAlwaysOnTop(true);
    }
    win.setMenuBarVisibility(false);
    win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(HIGHLIGHT_PAGE)}`);
    win.on("closed", () => {
      if (this.window === win) this.window = null;
    });
    this.window = win;
    return win;
  }

  show(rects) {
    const layout = layoutHighlight(rects, (rect) => screen.screenToDipRect(null, rect));
    if (!layout) {
      this.hide();
      return;
    }
    const key = JSON.stringify(layout);
    const win = this.ensureWindow();
    if (key !== this.lastLayoutKey) {
      this.lastLayoutKey = key;
      win.setBounds(layout.bounds);
      const paint = () => {
        win.webContents
          .executeJavaScript(`window.__render(${JSON.stringify(layout.boxes)})`)
          .catch(() => {});
      };
      if (win.webContents.isLoading()) {
        win.webContents.once("did-finish-load", paint);
      } else {
        paint();
      }
    }
    if (!this.active) {
      this.active = true;
      win.showInactive();
      this.onActiveChange?.(true);
    }
  }

  hide() {
    this.stopTracking();
    this.lastLayoutKey = "";
    if (this.window && !this.window.isDestroyed() && this.window.isVisible()) {
      this.window.hide();
    }
    if (this.active) {
      this.active = false;
      this.onActiveChange?.(false);
    }
  }

  /** The read ended: nothing to point at any more. */
  clear() {
    this.hide();
    this.lastIndex = -1;
    if (this.anchored) {
      this.anchored = false;
      this.anchorPromise = null;
      void this.send("clear");
    }
  }

  /** For the ledger's harness: is the highlight on screen, and where. */
  getStatus() {
    const win = this.window && !this.window.isDestroyed() ? this.window : null;
    return {
      supported: this.isSupported,
      workerReady: this.workerReady,
      anchored: this.anchored,
      active: this.active,
      bounds: win && this.active ? win.getBounds() : null,
    };
  }
}

module.exports = ReadAloudHighlight;
module.exports.layoutHighlight = layoutHighlight;
module.exports.PAD = PAD;
