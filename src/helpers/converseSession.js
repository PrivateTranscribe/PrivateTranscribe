/**
 * Converse session: the voice-loop state machine, main-process side.
 *
 * Ported from the validated voice-loop spike's main.cjs. It owns the turn
 * generation counter, the agent, the incremental sentence splitter, and the
 * state log the ledger gate reads.
 *
 * States:
 *   idle      before the first utterance
 *   thinking  utterance accepted, agent is answering
 *   speaking  the renderer reported audio actually playing
 *   listening a turn finished and playback drained
 *
 * Sentences are pushed to the overlay renderer one at a time
 * (`converse-sentence`) so synthesis can start on the first finished sentence
 * instead of the whole answer. The renderer reports playback back over
 * `converse-player-state`, which is the only thing that moves this machine into
 * `speaking` and out of it — the main process never guesses that audio played.
 */

const os = require("node:os");

const { ConverseAgent } = require("./converseAgent");
const { ConversePermissionRelay } = require("./conversePermissionRelay");
const { SentenceStream } = require("./converseSentences");
const { readSessionId, writeSessionId } = require("./converseSessionStore");

/** Keeps the log bounded on a long session without losing the recent shape. */
const STATE_LOG_LIMIT = 200;

class ConverseSession {
  /**
   * @param {object} opts
   * @param {(channel:string, payload:object)=>void} opts.send  to the overlay renderer
   * @param {string}  [opts.model]
   * @param {string}  [opts.cwd]
   * @param {string}  [opts.claudeBin]
   * @param {boolean} [opts.mock]
   * @param {boolean} [opts.resume] continue the last `claude` session recorded
   *   for this cwd instead of starting a fresh conversation
   * @param {string}  [opts.sessionStorePath] override the mapping file (tests)
   * @param {boolean} [opts.permissionRelay] carry the CLI's own permission
   *   questions to the user (ignored in mock mode, which spawns no CLI)
   * @param {boolean} [opts.strictMcpConfig] also pass `--strict-mcp-config`,
   *   which suppresses the user's own project MCP servers. Off by default; see
   *   ConverseAgent for why a real session must never turn it on.
   */
  constructor({
    send,
    model = "haiku",
    cwd,
    claudeBin,
    mock = false,
    resume = false,
    sessionStorePath,
    permissionRelay = false,
    strictMcpConfig = false,
    settingsFile = null,
  } = {}) {
    this.send = typeof send === "function" ? send : () => {};
    this.state = "idle";
    this.stateSince = Date.now();
    this.stateLog = [{ state: "idle", at: Date.now(), reason: "session created" }];

    this.turnGen = 0;
    /**
     * Staleness fence: turns with gen <= fence are dead (interrupted or the
     * session stopped). Deliberately separate from turnGen — a queued
     * follow-up advances turnGen while the previous turn is still live, and
     * that must NOT make the live turn's output look interrupted.
     */
    this.fence = 0;
    this.activeTurnGen = 0;
    this.sentenceStream = new SentenceStream();
    this.sentenceIndex = 0;
    this.lastResponse = { gen: 0, text: "", sentences: [] };
    this.lastUtterance = null;
    this.lastInterrupt = null;
    this.pendingInterrupt = null;
    this.player = null;
    this.stopped = false;

    /**
     * Queued-turn playback handoff. A follow-up utterance sent while the agent
     * is working starts its own turn the moment the previous one finishes —
     * but its sentences must not reach the player while the previous answer is
     * still coming out of the speakers, because the player resets its queue on
     * a new generation. `speakingGen` is the generation the player is busy
     * with; events for any other generation wait in `deferred` until the
     * player drains (or an interrupt clears everything).
     */
    this.speakingGen = null;
    this.deferred = [];
    /** Sentences per generation, so an interrupt can name what was actually
     * playing even when a queued turn has since become the live one. */
    this.sentencesByGen = new Map();

    // Resolved here rather than left to the agent's default, because the same
    // directory is also the key the session id is remembered under: the two
    // must not be able to disagree.
    this.cwd = cwd || os.tmpdir();
    this.sessionStorePath = sessionStorePath || null;

    // Mock mode never spawns a CLI, so there is no session to continue.
    this.resumedFrom = resume && !mock ? readSessionId(this.cwd, this.sessionStorePath) : null;
    this.sessionId = this.resumedFrom;

    // The agent is constructed in start(): with the permission relay on, its
    // spawn args need the relay's port, which only exists once it listens.
    this.agent = null;
    this._agentOpts = { model, claudeBin, mock, permissionRelay, strictMcpConfig, settingsFile };
    this.relay = null;
    this.lastAgentError = null;
  }

  async start() {
    const { model, claudeBin, mock, permissionRelay, strictMcpConfig, settingsFile } =
      this._agentOpts;

    let relayInfo = null;
    if (permissionRelay && !mock) {
      // The app adds no permission rules of its own: the relay only carries
      // the harness's own question to the user and their answer back.
      this.relay = new ConversePermissionRelay({
        onRequest: (entry) => {
          this.send("converse-permission-request", {
            id: entry.id,
            tool_name: entry.tool_name,
            input: entry.input,
            at: entry.at,
            // Carried so the prompt counts down to the relay's real deadline
            // instead of starting its own timer when the event happens to
            // arrive. The relay is the clock; the countdown only reads it.
            deadline: entry.deadline,
            timeoutMs: entry.timeoutMs,
          });
          // Spoken too, the way Codex announces approvals — a user who walked
          // away from the window would otherwise only discover the stalled
          // question when the deny timeout has already fired.
          this._speakServiceLine(
            "I need your approval to continue. Answer the question in the app."
          );
        },
      });
      relayInfo = await this.relay.start();
    }

    this.agent = new ConverseAgent({
      model,
      cwd: this.cwd,
      claudeBin,
      mock,
      resumeSessionId: this.resumedFrom,
      permissionRelay: relayInfo,
      strictMcpConfig,
      settingsFile: settingsFile || null,
      onSessionId: (id) => this._rememberSessionId(id),
      onTurnStart: (info) => this._onTurnStart(info),
      onDelta: (text) => this._onDelta(text),
      onTurnEnd: (info) => this._onTurnEnd(info),
      onError: (err) => {
        this.lastAgentError = err;
      },
    });

    try {
      await this.agent.start();
    } catch (err) {
      // A preflight failure (missing binary, etc.) must not leave the relay
      // listening with nothing left to answer its questions.
      if (this.relay) {
        this.relay.stop();
        this.relay = null;
      }
      throw err;
    }
    return this.getState();
  }

  /**
   * Persist the id the CLI just announced, so the next app run can resume it.
   * Best effort by design — a mapping that fails to save costs a resume, never
   * the conversation in progress.
   */
  _rememberSessionId(id) {
    this.sessionId = id;
    if (writeSessionId(this.cwd, id, this.sessionStorePath)) {
      console.log(`[converse] session ${id} recorded for ${this.cwd}`);
    } else {
      console.log(`[converse] could not record session ${id} for ${this.cwd}`);
    }
  }

  // ------------------------------------------------------------------ state

  setState(next, reason) {
    if (this.state === next) return;
    this.state = next;
    this.stateSince = Date.now();
    this.stateLog.push({ state: next, at: Date.now(), reason: reason || "" });
    if (this.stateLog.length > STATE_LOG_LIMIT) this.stateLog.shift();
    console.log(`[converse] -> ${next} (${reason || ""})`);
  }

  getState() {
    const status = this.agent
      ? this.agent.status()
      : { agentMode: this._agentOpts.mock ? "mock" : "live", model: this._agentOpts.model };
    return {
      state: this.state,
      stateForMs: Date.now() - this.stateSince,
      agentMode: status.agentMode,
      model: status.model,
      lastError: status.lastError,
      cwd: this.cwd,
      /** The CLI session this conversation is in, once the CLI has named it. */
      sessionId: status.sessionId || this.sessionId,
      /** The id this session was started with `--resume`, or null for a fresh one. */
      resumedFrom: this.resumedFrom,
      /** "folder" when Claude Code loads the folder's own setup, "user-only" when not. */
      projectSetup: status.projectSetup || null,
      turnGen: this.turnGen,
      stateLog: this.stateLog.slice(),
      player: this.player,
      agent: status,
      lastUtterance: this.lastUtterance,
      lastResponse: this.lastResponse,
      /**
       * Sentences per recent generation. The transcript builds from this
       * rather than from lastResponse alone: a short queued turn can stream
       * its whole answer and hand over to the next turn inside one 200ms UI
       * poll, and a snapshot of only the current turn would never show it.
       */
      recentResponses: Array.from(this.sentencesByGen.entries()).map(([gen, sentences]) => ({
        gen,
        sentences: sentences.slice(),
      })),
      lastInterrupt: this.lastInterrupt,
      // What the NEXT outbound utterance will be wrapped with: which sentences
      // the user heard, which one was cut mid-word, and which were never
      // spoken. Read-only — reading it does not consume it (only
      // withInterruptContext() does), so a test can check the wrapper the
      // session is about to build against the wrapper the agent actually
      // receives on its stdin.
      pendingInterrupt: this.pendingInterrupt,
      /**
       * Whether the CLI's own permission questions can reach the user at all.
       * False means no `--permission-prompt-tool` was passed, so a tool the
       * user's settings do not already allow is simply refused with no prompt.
       */
      permissionRelay: Boolean(this.relay),
      /** Every permission question the harness has asked, and how it was answered. */
      permissionLog: this.relay ? this.relay.getLog() : this._finalPermissionLog || [],
      running: !this.stopped,
    };
  }

  /** Arm a standing answer for permission questions ("allow" | "deny" | null). */
  setPermissionAutoAnswer(behavior) {
    if (!this.relay) return { armed: null, reason: "relay-not-active" };
    return { armed: this.relay.setAutoAnswer(behavior) };
  }

  /** Answer one pending permission question by id. */
  answerPermission(id, behavior) {
    if (!this.relay) return { answered: false, reason: "relay-not-active" };
    return { answered: this.relay.answer(id, { behavior }) };
  }

  // ------------------------------------------------------------- turn loop

  /**
   * The injection surface for a new user turn. Text only — the future mic path
   * transcribes first and calls exactly this, so the no-mic e2e exercises the
   * same code the microphone will.
   */
  sendUtterance(text) {
    const utterance = String(text ?? "").trim();
    if (!utterance) {
      return { accepted: false, reason: "empty-utterance", state: this.state };
    }
    if (this.stopped) {
      return { accepted: false, reason: "session-stopped", state: this.state };
    }
    if (!this.agent) {
      return { accepted: false, reason: "not-started", state: this.state };
    }

    this.turnGen += 1;
    const gen = this.turnGen;
    this.lastUtterance = { text: utterance, at: Date.now(), gen };

    // A mid-turn utterance is accepted and queued, the way Codex queues
    // follow-ups instead of refusing them: the agent (and the CLI under it)
    // runs it as the next turn the moment the current one finishes. The
    // per-turn resets happen in _onTurnStart, which fires when this turn
    // actually starts producing — immediately when the agent is idle.
    const queued = this.state === "thinking" || this.state === "speaking";

    const agentText = this.withInterruptContext(utterance);
    if (!this.agent.send(agentText, { gen })) {
      this.setState("listening", "agent refused the utterance");
      return { accepted: false, reason: "agent-unavailable", state: this.state, turnGen: gen };
    }

    return {
      accepted: true,
      queued,
      turnGen: gen,
      state: this.state,
      agentMode: this.agent.agentMode,
    };
  }

  /**
   * A turn became the one producing output. Deltas are stamped with the
   * generation of the turn that produced them, not the generation current
   * when they arrive: an interrupt bumps turnGen while the agent is still
   * streaming, and stamping at arrival time would let the dead turn's tail
   * re-enter as if it belonged to the new one.
   */
  _onTurnStart(info) {
    if (this.stopped) return;
    const gen = Number.isInteger(info?.gen) ? info.gen : this.turnGen;
    this.activeTurnGen = gen;
    this.sentenceStream = new SentenceStream();
    this.sentenceIndex = 0;
    // A queued turn that was interrupted while waiting still runs in the CLI,
    // but it is dead to the conversation: no resets, no state change — its
    // output is dropped sentence by sentence in _emitSentence.
    if (gen <= this.fence) return;
    this.activeTurnEnded = false;
    this.lastResponse = { gen, text: "", sentences: [], at: Date.now() };
    this.setState("thinking", `turn ${gen}`);
  }

  _onDelta(text) {
    const gen = this.activeTurnGen;
    for (const sentence of this.sentenceStream.push(text)) this._emitSentence(gen, sentence);
  }

  _emitSentence(gen, text) {
    if (gen <= this.fence) return; // interrupted mid-stream
    this.lastResponse.sentences.push(text);
    this.lastResponse.text = this.lastResponse.sentences.join(" ");
    this._rememberSentence(gen, text);
    this._dispatchToPlayer({ kind: "sentence", gen, index: this.sentenceIndex, text });
    this.sentenceIndex += 1;
  }

  _rememberSentence(gen, text) {
    let list = this.sentencesByGen.get(gen);
    if (!list) {
      list = [];
      this.sentencesByGen.set(gen, list);
      // Bounded: only the generations an interrupt could still name matter.
      while (this.sentencesByGen.size > 4) {
        this.sentencesByGen.delete(this.sentencesByGen.keys().next().value);
      }
    }
    list.push(text);
  }

  /**
   * The player resets its queue whenever it sees a new generation, so events
   * for a turn must not reach it while an older answer is still audible —
   * they wait here until the player reports that answer drained (or an
   * interrupt throws everything out).
   */
  _dispatchToPlayer(evt) {
    if (this.speakingGen !== null && this.speakingGen !== evt.gen) {
      this.deferred.push(evt);
      return;
    }
    if (evt.kind === "sentence") {
      this.speakingGen = evt.gen;
      this.send("converse-sentence", { gen: evt.gen, index: evt.index, text: evt.text });
    } else {
      this.send("converse-turn-end", { gen: evt.gen, total: evt.total });
    }
  }

  _flushDeferred() {
    const items = this.deferred;
    this.deferred = [];
    for (const evt of items) {
      // A deferred event can be stale by the time it is flushed.
      if (evt.gen <= this.fence) continue;
      this._dispatchToPlayer(evt);
    }
  }

  _onTurnEnd(info) {
    const gen = Number.isInteger(info?.gen) ? info.gen : this.activeTurnGen;
    for (const sentence of this.sentenceStream.flush()) this._emitSentence(gen, sentence);
    if (gen <= this.fence) return;

    this.activeTurnEnded = true;
    this._dispatchToPlayer({ kind: "turn-end", gen, total: this.sentenceIndex });
    this.lastTurnInfo = {
      firstTokenMs: info?.firstTokenMs ?? null,
      totalMs: info?.totalMs ?? null,
      mode: info?.mode ?? null,
    };

    if (this.sentenceIndex === 0 && this.speakingGen === null) {
      // Nothing to speak and nothing still playing, so playback will never
      // report a drain.
      this.setState("listening", "empty response");
    }
  }

  /**
   * Speak one line that did not come from the agent's answer — the Codex
   * appendSpeech idea, used for the approval announcement. Injected into the
   * live turn's sentence flow so synthesis, ducking and interrupt accounting
   * all treat it as ordinary speech.
   */
  _speakServiceLine(text) {
    if (this.stopped) return;
    if (this.activeTurnGen <= this.fence) return;
    if (this.state !== "thinking" && this.state !== "speaking") return;
    this._emitSentence(this.activeTurnGen, text);
  }

  // ---------------------------------------------------- renderer -> session

  /** @param {{gen:number, playIndex:number, playing:boolean, drained:boolean}} report */
  onPlayerState(report) {
    if (!report) return;
    // Reports can describe the current turn, the older answer still coming
    // out of the speakers while a queued turn runs, or the player's reset
    // after an interrupt (which reports with the fence generation, and is the
    // proof that playback actually stopped); anything else is stale.
    if (
      report.gen !== this.activeTurnGen &&
      report.gen !== this.speakingGen &&
      report.gen !== this.turnGen
    ) {
      return;
    }
    this.player = report;

    if (report.playing && this.state === "thinking" && report.gen === this.activeTurnGen) {
      this.setState("speaking", `sentence ${report.playIndex}`);
    }
    if (report.drained) {
      if (report.gen === this.speakingGen) {
        // The speakers are free; hand them to whichever turn was waiting.
        this.speakingGen = null;
        this._flushDeferred();
      }
      if (
        report.gen === this.activeTurnGen &&
        (this.state === "speaking" || this.state === "thinking")
      ) {
        this.setState("listening", "playback drained");
      } else if (
        this.speakingGen === null &&
        this.activeTurnEnded &&
        this.sentenceIndex === 0 &&
        (this.state === "speaking" || this.state === "thinking")
      ) {
        // A queued turn finished with nothing to say while the previous
        // answer was still audible: the drain just heard belongs to the old
        // generation, and no drain will ever arrive for the empty one.
        this.setState("listening", "empty response after drain");
      }
    }
  }

  // -------------------------------------------------------------- interrupt

  /**
   * Cut the current turn off. The generation bump makes every late sentence and
   * late agent delta stale, and the renderer resets its queue on the same
   * number. Barge-in wiring (mic VAD) is a later gate; the mechanism lives here
   * so that gate is a wiring change, not a rewrite.
   */
  interrupt(reason) {
    const from = this.state;
    this.turnGen += 1;
    // Everything up to and including this moment is dead: the streaming turn,
    // and any follow-up still queued behind it.
    this.fence = this.turnGen;
    this.sentenceStream = new SentenceStream();

    // Record what the user actually heard vs. what was cut off, so the next
    // turn can hand the agent that context. playIndex is the sentence that was
    // playing (partially heard); everything after it was never spoken. The
    // sentences are looked up by the generation the PLAYER was on — with a
    // queued turn live, lastResponse already belongs to a newer generation
    // than the audio that just got cut.
    const playerGen = this.player && Number.isInteger(this.player.gen) ? this.player.gen : null;
    const sentences =
      (playerGen !== null && this.sentencesByGen.get(playerGen)) ||
      (this.lastResponse && this.lastResponse.sentences) ||
      [];
    if (from === "speaking" && sentences.length > 0) {
      const idx =
        this.player && Number.isInteger(this.player.playIndex) ? this.player.playIndex : 0;
      this.pendingInterrupt = {
        heard: sentences.slice(0, idx),
        cutOff: sentences[idx] || null,
        unheard: sentences.slice(idx + 1),
      };
    } else if (from === "thinking") {
      this.pendingInterrupt = { heard: [], cutOff: null, unheard: sentences.slice() };
    }

    // Whatever was waiting for the speakers died with the turn it belonged to.
    this.speakingGen = null;
    this.deferred = [];

    this.lastInterrupt = { at: Date.now(), reason, from, playerWas: this.player };
    this.send("converse-interrupt", { gen: this.turnGen, reason });
    this.setState("listening", `interrupt: ${reason}`);
    return { turnGen: this.turnGen, from, state: this.state };
  }

  /**
   * Wrap the next user utterance with what the agent needs to know about the
   * interruption. Display text stays raw; only the agent sees the wrapper.
   */
  withInterruptContext(text) {
    const p = this.pendingInterrupt;
    if (!p) return text;
    this.pendingInterrupt = null;
    const parts = ["[You were interrupted mid-answer."];
    if (p.heard.length > 0) parts.push(`The user heard: "${p.heard.join(" ")}"`);
    else parts.push("The user heard none of your answer.");
    if (p.cutOff) parts.push(`You were cut off during: "${p.cutOff}"`);
    if (p.unheard.length > 0) parts.push(`Never spoken: "${p.unheard.join(" ")}"`);
    parts.push("Do not repeat what was heard unless asked. The user now says:]");
    return `${parts.join(" ")} ${text}`;
  }

  // ------------------------------------------------------------- lifecycle

  stop(reason = "session stopped") {
    if (this.stopped) return this.getState();
    this.stopped = true;
    this.turnGen += 1;
    this.fence = this.turnGen;
    this.speakingGen = null;
    this.deferred = [];
    if (this.agent) this.agent.stop();
    if (this.relay) {
      const finalState = this.getState();
      this.relay.stop();
      this.relay = null;
      this._finalPermissionLog = finalState.permissionLog;
    }
    this.send("converse-interrupt", { gen: this.turnGen, reason });
    this.setState("idle", reason);
    return this.getState();
  }
}

module.exports = { ConverseSession, STATE_LOG_LIMIT };
