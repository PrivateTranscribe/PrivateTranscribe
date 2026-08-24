/**
 * Converse session: the voice-loop state machine, main-process side.
 *
 * Ported from the validated voice-loop spike (C:\tmp\voice-loop-spike,
 * main.cjs). It owns the turn generation counter, the agent, the incremental
 * sentence splitter, and the state log the ledger gate reads.
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

const { ConverseAgent } = require("./converseAgent");
const { SentenceStream } = require("./converseSentences");

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
   */
  constructor({ send, model = "haiku", cwd, claudeBin, mock = false } = {}) {
    this.send = typeof send === "function" ? send : () => {};
    this.state = "idle";
    this.stateSince = Date.now();
    this.stateLog = [{ state: "idle", at: Date.now(), reason: "session created" }];

    this.turnGen = 0;
    this.sentenceStream = new SentenceStream();
    this.sentenceIndex = 0;
    this.lastResponse = { text: "", sentences: [] };
    this.lastUtterance = null;
    this.lastInterrupt = null;
    this.pendingInterrupt = null;
    this.player = null;
    this.stopped = false;

    this.agent = new ConverseAgent({
      model,
      cwd,
      claudeBin,
      mock,
      onDelta: (text) => this._onDelta(text),
      onTurnEnd: (info) => this._onTurnEnd(info),
      onError: (err) => {
        this.lastAgentError = err;
      },
    });
    this.lastAgentError = null;
  }

  async start() {
    await this.agent.start();
    return this.getState();
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
    const status = this.agent.status();
    return {
      state: this.state,
      stateForMs: Date.now() - this.stateSince,
      agentMode: status.agentMode,
      model: status.model,
      lastError: status.lastError,
      turnGen: this.turnGen,
      stateLog: this.stateLog.slice(),
      player: this.player,
      agent: status,
      lastUtterance: this.lastUtterance,
      lastResponse: this.lastResponse,
      lastInterrupt: this.lastInterrupt,
      running: !this.stopped,
    };
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
    if (this.state === "thinking" || this.state === "speaking") {
      // Barge-in is a separate gate; until then a mid-turn utterance is refused
      // rather than silently queued behind the one in flight.
      return { accepted: false, reason: "busy", state: this.state };
    }

    this.turnGen += 1;
    const gen = this.turnGen;
    this.sentenceStream = new SentenceStream();
    this.sentenceIndex = 0;
    this.lastResponse = { text: "", sentences: [], at: Date.now() };
    this.lastUtterance = { text: utterance, at: Date.now(), gen };
    this.setState("thinking", `turn ${gen}`);

    const agentText = this.withInterruptContext(utterance);
    if (!this.agent.send(agentText)) {
      this.setState("listening", "agent refused the utterance");
      return { accepted: false, reason: "agent-unavailable", state: this.state, turnGen: gen };
    }

    return { accepted: true, turnGen: gen, state: this.state, agentMode: this.agent.agentMode };
  }

  _onDelta(text) {
    const gen = this.turnGen;
    for (const sentence of this.sentenceStream.push(text)) this._emitSentence(gen, sentence);
  }

  _emitSentence(gen, text) {
    if (gen !== this.turnGen) return; // interrupted mid-stream
    this.lastResponse.sentences.push(text);
    this.lastResponse.text = this.lastResponse.sentences.join(" ");
    this.send("converse-sentence", { gen, index: this.sentenceIndex, text });
    this.sentenceIndex += 1;
  }

  _onTurnEnd(info) {
    const gen = this.turnGen;
    for (const sentence of this.sentenceStream.flush()) this._emitSentence(gen, sentence);
    if (gen !== this.turnGen) return;

    this.send("converse-turn-end", { gen, total: this.sentenceIndex });
    this.lastTurnInfo = {
      firstTokenMs: info?.firstTokenMs ?? null,
      totalMs: info?.totalMs ?? null,
      mode: info?.mode ?? null,
    };

    if (this.sentenceIndex === 0) {
      // Nothing to speak, so playback will never report a drain.
      this.setState("listening", "empty response");
    }
  }

  // ---------------------------------------------------- renderer -> session

  /** @param {{gen:number, playIndex:number, playing:boolean, drained:boolean}} report */
  onPlayerState(report) {
    if (!report || report.gen !== this.turnGen) return;
    this.player = report;

    if (report.playing && this.state === "thinking") {
      this.setState("speaking", `sentence ${report.playIndex}`);
    }
    if (report.drained && (this.state === "speaking" || this.state === "thinking")) {
      this.setState("listening", "playback drained");
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
    this.sentenceStream = new SentenceStream();

    // Record what the user actually heard vs. what was cut off, so the next
    // turn can hand the agent that context. playIndex is the sentence that was
    // playing (partially heard); everything after it was never spoken.
    const sentences = (this.lastResponse && this.lastResponse.sentences) || [];
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
    this.agent.stop();
    this.send("converse-interrupt", { gen: this.turnGen, reason });
    this.setState("idle", reason);
    return this.getState();
  }
}

module.exports = { ConverseSession, STATE_LOG_LIMIT };
