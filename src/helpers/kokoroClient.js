/**
 * Kokoro TTS client — the main-process face of the engine that actually lives
 * in a utilityProcess (kokoroHost.js).
 *
 * Why a child process at all: synthesis is fp32 CPU inference. Even with the
 * intra-op thread cap in kokoro.js it bursts to ~44% of a 32-thread machine at
 * normal priority, which the user feels as the whole computer lagging every
 * time Read Aloud or Converse speaks. Running the engine in a child and
 * dropping that child to below-normal OS priority makes the burn yield to
 * every foreground app: on an idle machine synthesis speed is unchanged, on a
 * busy one the machine stays responsive and synthesis is what waits.
 *
 * Why the client schedules instead of just forwarding: onnxruntime-node's
 * inference blocks the child's JS thread, so once a request is running the
 * child cannot even receive the next message — everything sent to a busy child
 * serializes FIFO (measured: a press's head-chunk synth waited ~1.5s behind
 * three prefetch sentences; the old in-process engine answered the same press
 * in ~300ms because requests could slip in at await boundaries). The queue
 * here restores that responsiveness deliberately rather than by luck:
 *
 *   - one request in the child at a time — also caps the CPU burn to a single
 *     synthesis, where the old engine would run three at once;
 *   - "interactive" synths (the sentence the listener is waiting on) go ahead
 *     of queued "prefetch" synths (lookahead);
 *   - prefetch jobs are held PREFETCH_HOLD_MS after enqueue before they may
 *     start, so a quick re-press or seek finds the engine idle instead of
 *     stuck behind an unpreemptable lookahead synthesis;
 *   - a synth carrying a newer epoch drops queued synths from older epochs on
 *     the same channel (rejected with code "stale-synth") — a new speak()
 *     makes the previous press's lookahead worthless.
 *
 * Split of responsibilities:
 *   - model files on disk (status, download, delete) stay in-process — cheap
 *     fs work, handled by a local KokoroManager that never loads the engine;
 *   - sentence splitting stays in-process too (pure JS, no model) so a press's
 *     split can never wait behind a synthesis;
 *   - engine load and synthesis are RPC to the child, through the queue.
 *
 * The public surface mirrors KokoroManager, so ipcHandlers.js keeps calling
 * the same methods. getEngineStatus() answers from a local mirror because the
 * child cannot reply mid-inference.
 */

const { utilityProcess } = require("electron");
const os = require("os");
const path = require("path");
const debugLogger = require("./debugLogger");
const KokoroManager = require("./kokoro");

/** Generous: covers a cold engine load; a child gone quiet is dead, not slow. */
const CALL_TIMEOUT_MS = 120_000;
/**
 * How long a prefetch synth waits after enqueue before it may occupy the
 * engine. Within this window a press or seek starts instantly; outside it, an
 * in-flight lookahead can cost the press up to one sentence (~700ms). Playback
 * is seconds ahead of prefetch, so the hold never causes an audible gap.
 */
const PREFETCH_HOLD_MS = 300;

function typedError(code, message) {
  return Object.assign(new Error(message), { code });
}

class KokoroClient {
  constructor() {
    /** Disk-only manager: model status, download, delete. Never loads the engine. */
    this.files = new KokoroManager();
    this.child = null;
    this.inflight = null;
    this.queue = [];
    this.holdTimer = null;
    this.nextId = 1;
    /** Newest epoch seen per channel; queued synths from older epochs are stale. */
    this.epochs = new Map();
    /** Local mirror; the child cannot answer a status request mid-inference. */
    this.engineStatus = { loaded: false, loading: false, coldStartMs: 0, error: null };
  }

  // ----------------------------------------------------- disk ops (in-process)

  checkModelStatus(modelId) {
    return this.files.checkModelStatus(modelId);
  }

  downloadKokoroModel(modelId, progressCallback) {
    return this.files.downloadKokoroModel(modelId, progressCallback);
  }

  cancelDownload() {
    return this.files.cancelDownload();
  }

  async deleteModel(modelId) {
    // The child holds file handles on the weights; drop it before the rm.
    this.unloadEngine();
    return this.files.deleteModel(modelId);
  }

  // ------------------------------------------------- split (in-process, no model)

  /** Same splitter kokoro-js uses internally; pure JS, so it never queues. */
  async splitSentences(text) {
    const { TextSplitterStream } = await import("kokoro-js");
    const splitter = new TextSplitterStream();
    splitter.push(String(text ?? ""));
    return [...splitter];
  }

  // -------------------------------------------------------- engine ops (child)

  async loadEngine(modelId) {
    this.engineStatus.loading = true;
    try {
      const status = await this._enqueue("load-engine", { modelId }, { kind: "interactive" });
      this.engineStatus = { ...status, loading: false };
      return status;
    } catch (error) {
      this.engineStatus.loading = false;
      this.engineStatus.error = String(error?.message || error);
      throw error;
    }
  }

  getEngineStatus() {
    if (!this.child) {
      return { ...this.engineStatus, loaded: false };
    }
    return { ...this.engineStatus };
  }

  /**
   * @param {object} options voice/speed go to the engine; priority
   *   ("interactive" | "prefetch"), epoch and channel steer the queue only.
   */
  synthesize(text, { voice, speed, priority, epoch, channel } = {}) {
    const kind = priority === "prefetch" ? "prefetch" : "interactive";
    const chan = channel || "default";

    // Dropping stale queued work is an optimization, never a gate: a lower
    // epoch is accepted as-is (a recreated player legitimately restarts at 0);
    // the renderer's own epoch guards remain the correctness boundary.
    if (Number.isFinite(epoch)) {
      const newest = this.epochs.get(chan);
      if (newest === undefined || epoch > newest) {
        this.epochs.set(chan, epoch);
        this._dropStale(chan, epoch);
      }
    }

    return this._enqueue("synth", { text, options: { voice, speed } }, { kind, chan, epoch });
  }

  /** Kill the child outright; the next engine call spawns a fresh one. */
  unloadEngine() {
    const child = this.child;
    this.engineStatus = { loaded: false, loading: false, coldStartMs: 0, error: null };
    if (!child) return;
    this.child = null;
    this._rejectAll(typedError("engine-unloaded", "Kokoro engine was unloaded"));
    try {
      child.kill();
    } catch {
      // Already gone.
    }
  }

  // ------------------------------------------------------------------ queue

  _dropStale(chan, epoch) {
    const stale = this.queue.filter(
      (job) => job.chan === chan && Number.isFinite(job.epoch) && job.epoch < epoch
    );
    if (stale.length === 0) return;
    this.queue = this.queue.filter((job) => !stale.includes(job));
    for (const job of stale) {
      job.reject(typedError("stale-synth", `Synthesis from epoch ${job.epoch} superseded`));
    }
  }

  _enqueue(op, args, { kind = "interactive", chan = null, epoch = null } = {}) {
    return new Promise((resolve, reject) => {
      this.queue.push({ op, args, kind, chan, epoch, enqueuedAt: Date.now(), resolve, reject });
      this._pump();
    });
  }

  _nextJob() {
    const interactiveAt = this.queue.findIndex((job) => job.kind === "interactive");
    if (interactiveAt >= 0) return this.queue.splice(interactiveAt, 1)[0];

    if (this.queue.length === 0) return null;
    const job = this.queue[0];
    const readyAt = job.enqueuedAt + PREFETCH_HOLD_MS;
    const wait = readyAt - Date.now();
    if (wait > 0) {
      // Not eligible yet; wake up when it is (or when an interactive arrives,
      // which pumps immediately).
      if (!this.holdTimer) {
        this.holdTimer = setTimeout(() => {
          this.holdTimer = null;
          this._pump();
        }, wait);
      }
      return null;
    }
    this.queue.shift();
    return job;
  }

  _pump() {
    if (this.inflight) return;
    const job = this._nextJob();
    if (!job) return;

    const child = this._ensureChild();
    const id = this.nextId++;
    const timer = setTimeout(() => {
      if (this.inflight && this.inflight.id === id) {
        const { reject } = this.inflight;
        this.inflight = null;
        reject(typedError("kokoro-host-timeout", `Kokoro ${job.op} timed out`));
        // A child that swallowed a request is not trustworthy; start fresh.
        this.unloadEngine();
      }
    }, CALL_TIMEOUT_MS);

    this.inflight = {
      id,
      op: job.op,
      timer,
      resolve: (value) => {
        clearTimeout(timer);
        job.resolve(value);
      },
      reject: (error) => {
        clearTimeout(timer);
        job.reject(error);
      },
    };
    child.postMessage({ id, op: job.op, args: job.args });
  }

  _onChildMessage(msg) {
    const current = this.inflight;
    if (!current || !msg || msg.id !== current.id) return;
    this.inflight = null;
    if (msg.ok) {
      current.resolve(msg.result);
    } else {
      current.reject(typedError(msg.error?.code || "kokoro-host-error", msg.error?.message));
    }
    this._pump();
  }

  _rejectAll(error) {
    if (this.holdTimer) {
      clearTimeout(this.holdTimer);
      this.holdTimer = null;
    }
    const inflight = this.inflight;
    this.inflight = null;
    if (inflight) inflight.reject(error);
    const queued = this.queue;
    this.queue = [];
    for (const job of queued) job.reject(error);
  }

  // ------------------------------------------------------------------ child

  _ensureChild() {
    if (this.child) return this.child;

    const child = utilityProcess.fork(path.join(__dirname, "kokoroHost.js"), [], {
      serviceName: "PrivateTranscribe Kokoro TTS",
    });

    child.once("spawn", () => {
      // The entire point of the child: it competes below every normal-priority
      // process, so a synthesis burst can no longer lag the rest of the machine.
      try {
        os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
        debugLogger.info("Kokoro host spawned at below-normal priority", { pid: child.pid });
      } catch (error) {
        debugLogger.warn("Kokoro host priority drop failed; synthesis runs at normal", {
          pid: child.pid,
          error: error?.message,
        });
      }
    });

    child.on("message", (msg) => this._onChildMessage(msg));

    child.once("exit", (code) => {
      if (this.child === child) {
        this.child = null;
        this.engineStatus = {
          loaded: false,
          loading: false,
          coldStartMs: 0,
          error: code === 0 ? null : `Kokoro host exited with code ${code}`,
        };
      }
      this._rejectAll(
        typedError("kokoro-host-exited", `Kokoro host exited with code ${code} mid-request`)
      );
      debugLogger.info("Kokoro host exited", { code });
    });

    this.child = child;
    return child;
  }
}

module.exports = KokoroClient;
module.exports.PREFETCH_HOLD_MS = PREFETCH_HOLD_MS;
