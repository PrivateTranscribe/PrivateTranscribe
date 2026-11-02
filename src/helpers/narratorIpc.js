/**
 * IPC for the agent narrator (src/helpers/narrator). Registered from
 * ipcHandlers.js; kept here so the narrator's channels read as one unit.
 *
 * Playback lives in the overlay window, which is always open. Main streams an
 * item on "narrator-play" as it is made: a "begin" (with or without the
 * chime), one "part" per sentence, then "end". The overlay answers on
 * "narrator-playback": "started" when the first sound plays, then "done" or
 * "stopped".
 */

const crypto = require("node:crypto");
const debugLogger = require("./debugLogger");
const { Narrator } = require("./narrator");
const { PiperVoice, RoestVoice, KokoroVoice } = require("./narrator/voices");

/** Slack on top of the audio's own length before a playback counts as lost. */
const PLAYBACK_SLACK_MS = 15_000;
/** The overlay holds speech while a dictation runs, for at most this long (narratorPlayer.js). */
const HOLD_MAX_MS = 60_000;

function setupNarratorHandlers({ ipcMain, app, shell, windowManager, kokoroManager, broadcast }) {
  const log = (message, data) => debugLogger.info(message, data, "narrator");
  const overlay = () => {
    const win = windowManager?.mainWindow;
    return win && !win.isDestroyed() ? win.webContents : null;
  };

  /** Playbacks the overlay has not reported finished, by job id. */
  const jobs = new Map();
  let narrator = null;

  const voices = {
    "piper-da": new PiperVoice({ log }),
    "roest-da": new RoestVoice({ log }),
    "kokoro-en": new KokoroVoice({
      kokoro: kokoroManager,
      getVoiceId: () => narrator?.settings.voiceEn || "bm_lewis",
    }),
  };

  /**
   * One item's playback in the overlay. `started` resolves with the time the
   * first sound played, or null if none did; `result` with how it ended.
   */
  const openPlayback = ({ chime = false } = {}) => {
    const jobId = crypto.randomUUID();
    let startedAt = null;
    let audioMs = 0;
    let ended = false;
    let settled = false;
    let timer = null;
    let resolveStarted;
    let resolveResult;
    const started = new Promise((resolve) => {
      resolveStarted = resolve;
    });
    const result = new Promise((resolve) => {
      resolveResult = resolve;
    });

    const settle = (state) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      jobs.delete(jobId);
      resolveStarted(startedAt);
      resolveResult(state);
    };
    // A window that never answers must not hold the narrator's queue: once the
    // last sentence is sent, the job ends when its audio could at the latest.
    const arm = () => {
      if (settled || !ended) return;
      clearTimeout(timer);
      const hold = startedAt === null ? HOLD_MAX_MS : 0;
      timer = setTimeout(() => settle("timeout"), hold + audioMs + PLAYBACK_SLACK_MS);
    };
    const send = (message) => {
      if (settled) return;
      const target = overlay();
      if (target) target.send("narrator-play", { jobId, ...message });
      else settle("no-overlay");
    };

    jobs.set(jobId, {
      started: () => {
        if (startedAt !== null) return;
        startedAt = Date.now();
        resolveStarted(startedAt);
        arm();
      },
      finish: settle,
    });
    send({ type: "begin", chime });

    return {
      push(part) {
        if (settled) return;
        audioMs += (part.pcm.length / (part.sampleRate || 22050)) * 1000;
        send({ type: "part", pcm: part.pcm, sampleRate: part.sampleRate });
        arm();
      },
      end() {
        if (settled) return;
        ended = true;
        send({ type: "end" });
        arm();
      },
      cancel() {
        if (settled) return;
        overlay()?.send("narrator-play", { jobId, type: "cancel" });
        settle("stopped");
      },
      started,
      result,
    };
  };

  narrator = new Narrator({
    dataDir: app.getPath("userData"),
    openPlayback,
    stopPlayback: () => {
      overlay()?.send("narrator-stop-playback");
      for (const job of Array.from(jobs.values())) job.finish("stopped");
    },
    voices,
    openUrl: (url) => {
      shell
        .openExternal(url)
        .catch((error) => log("Narrator could not open a chat", { error: error.message }));
    },
    onState: (state) => broadcast("narrator-state", state),
    log,
  });

  ipcMain.on("narrator-playback", (_event, payload) => {
    const job = jobs.get(payload?.jobId);
    if (!job) return;
    if (payload.state === "started") job.started();
    else job.finish(payload.state === "stopped" ? "stopped" : "done");
  });

  ipcMain.handle("narrator-set-gate", (_event, experimentalOn) => {
    narrator.setGate(Boolean(experimentalOn));
    return narrator.getState();
  });
  ipcMain.handle("narrator-get-state", () => narrator.getState());
  ipcMain.handle("narrator-update-settings", (_event, patch) =>
    narrator.updateSettings(patch || {})
  );
  ipcMain.handle("narrator-command", (_event, name, language) =>
    narrator.command(String(name), language)
  );
  ipcMain.handle("narrator-utterance", (_event, text) =>
    narrator.handleUtterance(String(text || ""))
  );
  ipcMain.handle("narrator-stop", () => {
    narrator.stop();
    return true;
  });
  ipcMain.handle("narrator-test-voice", (_event, language) => {
    narrator.test(language);
    return true;
  });
  ipcMain.handle("narrator-open", (_event, itemId) => narrator.open(String(itemId)));
  ipcMain.handle("narrator-dismiss", (_event, itemId) => {
    narrator.dismiss(String(itemId));
    return narrator.getState();
  });
  ipcMain.handle("narrator-follow", (_event, chatId, on) => {
    if (on) narrator.follow(String(chatId));
    else narrator.unfollow(String(chatId));
    return narrator.getState();
  });
  ipcMain.handle("narrator-voice-status", async () => ({
    "piper-da": voices["piper-da"].status(),
    "roest-da": voices["roest-da"].status(),
    "kokoro-en": await voices["kokoro-en"].status(),
  }));
  ipcMain.handle("narrator-download-voice", async (event, id) => {
    if (id !== "piper-da")
      return { ok: false, error: "Only the Danish Piper voice downloads from the app" };
    try {
      const status = await voices["piper-da"].download((progress) => {
        if (!event.sender.isDestroyed()) event.sender.send("narrator-download-progress", progress);
      });
      return { ok: true, status };
    } catch (error) {
      log("Narrator voice download failed", { error: error.message });
      return { ok: false, error: error.message };
    }
  });
  ipcMain.handle("narrator-remove-voice", async (_event, id) => {
    if (id !== "piper-da") return false;
    await voices["piper-da"].remove();
    return true;
  });

  return narrator;
}

module.exports = { setupNarratorHandlers };
