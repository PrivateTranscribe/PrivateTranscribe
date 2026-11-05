/**
 * IPC for the agent narrator (src/helpers/narrator). Registered from
 * ipcHandlers.js; kept here so the narrator's channels read as one unit.
 *
 * Playback lives in the overlay window, which is always open. Main streams an
 * item on "narrator-play" as it is made: a "begin" (with or without the
 * chime), one "part" per sentence, then "end". The overlay answers on
 * "narrator-playback": "started" when the first sound plays, then "done" or
 * "stopped".
 *
 * Voice answers: while a question's answer window is open, the window manager
 * hands dictation key events to the narrator instead of the overlay's
 * dictation. Main tells the overlay's answer recorder to "start", "stop" or
 * "discard" on "narrator-answer"; the overlay sends the local transcript back
 * on "narrator-answer-heard".
 *
 * ask_by_voice: while the narrator runs with "Answer by voice" on, a local
 * server (narrator/askServer.js) takes questions from the Claude Code bridge.
 * With the switch off, nothing listens.
 */

const crypto = require("node:crypto");
const debugLogger = require("./debugLogger");
const { Narrator } = require("./narrator");
const { NarratorAskServer, askCommand, ALLOW_RULE } = require("./narrator/askServer");
const { PiperVoice, RoestVoice, KokoroVoice } = require("./narrator/voices");
const { VoiceCallMeter } = require("./narrator/voiceCallMeter");

/** Slack on top of the audio's own length before a playback counts as lost. */
const PLAYBACK_SLACK_MS = 15_000;
/** The overlay holds speech while a dictation runs, for at most this long (narratorPlayer.js). */
const HOLD_MAX_MS = 60_000;

/**
 * Room for the narrator's voice: a voice call to wait on, and other apps to
 * lower while it speaks. The lowering is Read Aloud's, so it holds the duck
 * only when Read Aloud does not, and never puts back one Read Aloud made.
 */
function createRoom({ ducking, log }) {
  const meter = new VoiceCallMeter({ log });
  let holding = false;
  return {
    watchCall: () => meter.watch(),
    async duck() {
      if (!ducking || ducking.busy) return false;
      await ducking.duckOthers();
      // False when nothing moved, as on another platform or under the e2e switch.
      holding = ducking.ducked;
      return holding;
    },
    async restore() {
      if (!holding) return;
      holding = false;
      await ducking.restore();
    },
  };
}

function setupNarratorHandlers({
  ipcMain,
  app,
  shell,
  windowManager,
  kokoroManager,
  ducking = null,
  broadcast,
}) {
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

  const answerRecorder = {
    start: (id, { language } = {}) =>
      overlay()?.send("narrator-answer", { type: "start", id, language }),
    stop: (id) => overlay()?.send("narrator-answer", { type: "stop", id }),
    discard: (id) => overlay()?.send("narrator-answer", { type: "discard", id }),
  };

  const askServer = new NarratorAskServer({
    dataDir: app.getPath("userData"),
    ask: (question, opts) => narrator.askByVoice(question, opts),
    log,
  });
  let askWanted = false;
  /** The server listens only while a question could be answered at all. */
  const syncAskServer = (state) => {
    const wanted = Boolean(state.running && state.settings.answerByVoice);
    if (wanted === askWanted) return;
    askWanted = wanted;
    if (wanted) askServer.start().catch(() => {});
    else void askServer.stop();
  };

  let shownQuestionId = null;
  /**
   * A voice question is drawn in the overlay, so an overlay hidden with Escape
   * comes back for it: once per question, without focus, as a dictation does.
   * showDictationPanel keeps a snoozed or switched-off overlay hidden.
   */
  const showQuestion = (state) => {
    const question = state.question;
    if (!question || question.phase !== "speaking" || question.id === shownQuestionId) return;
    shownQuestionId = question.id;
    Promise.resolve(windowManager?.showDictationPanel?.()).catch((error) =>
      log("Narrator could not show the overlay for a question", { error: error?.message })
    );
  };

  narrator = new Narrator({
    dataDir: app.getPath("userData"),
    openPlayback,
    stopPlayback: () => {
      overlay()?.send("narrator-stop-playback");
      for (const job of Array.from(jobs.values())) job.finish("stopped");
    },
    voices,
    room: createRoom({ ducking, log }),
    answerRecorder,
    openUrl: (url) => {
      shell
        .openExternal(url)
        .catch((error) => log("Narrator could not open a chat", { error: error.message }));
    },
    onState: (state) => {
      syncAskServer(state);
      showQuestion(state);
      broadcast("narrator-state", state);
    },
    onDispose: () => askServer.close(),
    log,
  });

  ipcMain.on("narrator-playback", (_event, payload) => {
    const job = jobs.get(payload?.jobId);
    if (!job) return;
    if (payload.state === "started") job.started();
    else job.finish(payload.state === "stopped" ? "stopped" : "done");
  });

  // Inside an answer window the dictation key answers; outside it, it dictates.
  windowManager?.setDictationKeyFilter?.((event) => narrator.answers.onKey(event));
  ipcMain.on("narrator-answer-heard", (_event, payload) => {
    narrator.answers.heard(String(payload?.id || ""), {
      text: typeof payload?.text === "string" ? payload.text.slice(0, 500) : "",
      error: payload?.error ? String(payload.error) : null,
    });
  });
  ipcMain.handle("narrator-set-local-only", (_event, localOnly) => {
    narrator.setLocalOnly(Boolean(localOnly));
    return true;
  });

  ipcMain.handle("narrator-set-gate", (_event, experimentalOn) => {
    narrator.setGate(Boolean(experimentalOn));
    return narrator.getState();
  });
  ipcMain.handle("narrator-get-state", () => narrator.getState());
  ipcMain.handle("narrator-ask-command", () => ({
    command: askCommand({
      userData: app.getPath("userData"),
      execPath: process.execPath,
      packaged: app.isPackaged,
    }),
    allowRule: ALLOW_RULE,
  }));
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
