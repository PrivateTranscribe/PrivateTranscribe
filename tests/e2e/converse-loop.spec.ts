import { expect, test } from "./fixtures/electron-app";

/**
 * Ledger gate `converse-loop-headless`: prove the whole voice loop runs inside
 * the app without a microphone — a text utterance goes to a persistent agent,
 * the streamed reply is split into sentences, Kokoro synthesizes them, playback
 * activates, and the session walks idle -> thinking -> speaking -> listening.
 *
 * The mode is an env switch so the same spec covers both halves of the gate:
 *
 *   PT_CONVERSE_E2E_MODE=mock  (default) deterministic canned reply, no CLI,
 *                              no live prompt spent, no network.
 *   PT_CONVERSE_E2E_MODE=live  the real `claude` CLI.
 *
 * Everything except the agent is identical between the two, and a live run
 * FAILS if the agent fell back to mock: a mock reply must never close the live
 * gate. Kokoro, the sentence splitter, the queue player, and the state machine
 * are the real ones in both modes.
 */

const MODE = process.env.PT_CONVERSE_E2E_MODE === "live" ? "live" : "mock";
const TURN_TIMEOUT_MS = MODE === "live" ? 60_000 : 15_000;
const POLL_MS = 25;

const UTTERANCE = "Reply with exactly two short sentences about local dictation.";

type Transition = { state: string; at: number; reason: string };

type ConverseState = {
  state: string;
  agentMode?: string;
  model?: string;
  lastError?: string | null;
  turnGen?: number;
  stateLog?: Transition[];
  player?: { playing: boolean; playIndex: number; drained: boolean } | null;
  lastResponse?: { text: string; sentences: string[] } | null;
};

/** Index of the first entry at or after `from` whose state is `state`. */
function findFrom(log: Transition[], state: string, from: number): number {
  for (let i = from; i < log.length; i++) {
    if (log[i].state === state) return i;
  }
  return -1;
}

test.use({ seedKokoroModel: true });

test.describe("converse loop (headless, no microphone)", () => {
  // A cold Kokoro load plus a full agent turn; the default 30s cannot cover it.
  test.setTimeout(MODE === "live" ? 240_000 : 180_000);

  test(`completes a text-injected turn in ${MODE} mode`, async ({ overlayWindow }) => {
    await overlayWindow.waitForFunction(() => Boolean((window as any).__converseTest), null, {
      timeout: 30_000,
    });

    // Cold model load is paid outside the turn, exactly as the Read Aloud gate
    // does it: 326MB of weights off disk is not part of a conversational turn.
    const engineStatus = await overlayWindow.evaluate(
      async () => await (window as any).electronAPI.readAloudLoadEngine()
    );
    expect(engineStatus.loaded, `engine failed to load: ${engineStatus.error}`).toBe(true);

    const started: ConverseState = await overlayWindow.evaluate(
      async (mock) => await (window as any).electronAPI.converseStart({ mock, model: "haiku" }),
      MODE === "mock"
    );
    expect(started.state, "session did not start in idle").toBe("idle");
    expect(started.agentMode, "session started in the wrong agent mode").toBe(MODE);

    const accepted = await overlayWindow.evaluate(
      async (text) => await (window as any).electronAPI.converseSendUtterance(text),
      UTTERANCE
    );
    expect(accepted.accepted, `utterance refused: ${accepted.reason}`).toBe(true);

    // Polled in-page so the 25ms sampling is real sampling rather than one
    // IPC round trip per tick from the test runner.
    const result: { sawPlaying: boolean; timedOut: boolean; state: ConverseState } =
      await overlayWindow.evaluate(
        async ({ timeoutMs, pollMs }) => {
          const api = (window as any).electronAPI;
          const deadline = Date.now() + timeoutMs;
          let sawPlaying = false;
          for (;;) {
            const state = await api.converseGetState();
            if (state?.player?.playing) sawPlaying = true;
            if (state?.state === "listening") return { sawPlaying, timedOut: false, state };
            if (Date.now() > deadline) return { sawPlaying, timedOut: true, state };
            await new Promise((resolve) => setTimeout(resolve, pollMs));
          }
        },
        { timeoutMs: TURN_TIMEOUT_MS, pollMs: POLL_MS }
      );

    const log = result.state.stateLog ?? [];

    // One line so the ledger can be filled straight from the runner output.
    console.log(
      `CONVERSE_STATELOG=[${log.map((t) => `${t.state}@${t.at}(${t.reason})`).join(", ")}]`
    );
    console.log(`CONVERSE_MODE=${result.state.agentMode} REPLY=${result.state.lastResponse?.text}`);

    expect(result.timedOut, `turn never returned to listening (state: ${result.state.state})`).toBe(
      false
    );

    // A live run that quietly degraded to the canned reply proves nothing about
    // the live path, so it is a failure rather than a pass with a footnote.
    expect(
      result.state.agentMode,
      `agent mode changed (lastError: ${result.state.lastError})`
    ).toBe(MODE);
    if (MODE === "mock") {
      expect(result.state.lastError, "mock run recorded an agent error").toBeFalsy();
    }

    // The gate is the full transition sequence, in order, with real timestamps.
    const idleAt = findFrom(log, "idle", 0);
    expect(idleAt, "no idle state was logged").toBeGreaterThanOrEqual(0);
    const thinkingAt = findFrom(log, "thinking", idleAt + 1);
    expect(thinkingAt, "no thinking state after idle").toBeGreaterThan(idleAt);
    const speakingAt = findFrom(log, "speaking", thinkingAt + 1);
    expect(speakingAt, "no speaking state after thinking").toBeGreaterThan(thinkingAt);
    const listeningAt = findFrom(log, "listening", speakingAt + 1);
    expect(listeningAt, "no listening state after speaking").toBeGreaterThan(speakingAt);

    const stamps = [idleAt, thinkingAt, speakingAt, listeningAt].map((i) => log[i].at);
    for (let i = 1; i < stamps.length; i++) {
      expect(stamps[i], `timestamp ${i} did not advance`).toBeGreaterThan(stamps[i - 1]);
    }

    expect(result.sawPlaying, "playback never reported playing").toBe(true);
    expect(result.state.lastResponse?.sentences?.length, "reply produced no sentences").toBeGreaterThan(
      0
    );

    const stopped: ConverseState = await overlayWindow.evaluate(
      async () => await (window as any).electronAPI.converseStop()
    );
    expect(stopped.running, "session still running after stop").toBe(false);
  });
});
