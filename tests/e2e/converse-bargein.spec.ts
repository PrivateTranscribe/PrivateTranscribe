import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "./fixtures/electron-app";

/**
 * Ledger gate `converse-barge-in`.
 *
 * Two claims, both measured against something the app cannot fake:
 *
 *  1. An interrupt injected while the app is genuinely speaking stops playback
 *     in under 250ms, five times out of five. The clock is the test runner's,
 *     started immediately before the interrupt call and stopped when the
 *     renderer's own player has reported `playing: false` on the post-interrupt
 *     generation — so every IPC hop is inside the number.
 *
 *  2. The next prompt the app sends to the agent carries the interruption
 *     wrapper naming the sentence that was actually cut. This is asserted
 *     against the raw stdin line the app wrote to the agent process, read back
 *     from the agent's own log file — not against the session's summary of
 *     itself.
 *
 * The agent is a stub `claude` (tests/e2e/fixtures/claude-stub.cjs) spoken to
 * over the real live path: real spawn, real stream-json, real turn accounting.
 * `mock: false`, and the test fails if the session ever reports agent mode
 * "mock". No live Claude prompt is spent, and no microphone is involved —
 * the interrupt is injected exactly where the mic VAD will call it.
 */

const STUB_PATH = path.join(__dirname, "fixtures", "claude-stub.cjs");
const STUB_LOG = path.join(os.tmpdir(), `pt-converse-stub-${process.pid}-${Date.now()}.log`);

/** Must stay identical to LONG_SENTENCES in claude-stub.cjs. */
const STUB_SENTENCES = [
  "Stub sentence one.",
  "Stub sentence two.",
  "Stub sentence three.",
  "Stub sentence four.",
  "Stub sentence five.",
  "Stub sentence six.",
  "Stub sentence seven.",
  "Stub sentence eight.",
];

/** Contains the stub's long-answer marker, so every run gets eight sentences. */
const LONG_UTTERANCE = "Tell me everything.";
const FINAL_UTTERANCE = "Continue please.";

const RUNS = 5;
const STOP_BUDGET_MS = 250;
const POLL_MS = 10;

type PlayerReport = {
  gen: number;
  playing: boolean;
  playIndex: number;
  drained: boolean;
} | null;

type ConverseState = {
  state: string;
  agentMode?: string;
  turnGen?: number;
  lastError?: string | null;
  stateLog?: { state: string; at: number; reason: string }[];
  player?: PlayerReport;
  lastResponse?: { text: string; sentences: string[] } | null;
  lastInterrupt?: { at: number; reason: string; from: string; playerWas: PlayerReport } | null;
  pendingInterrupt?: { heard: string[]; cutOff: string | null; unheard: string[] } | null;
  agent?: { busy?: boolean };
  running?: boolean;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Every user line the app has written to the stub's stdin so far. */
function readStubUserLines(): string[] {
  if (!fs.existsSync(STUB_LOG)) return [];
  return fs
    .readFileSync(STUB_LOG, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function textOfStubLine(line: string): string {
  const parsed = JSON.parse(line);
  const content = parsed?.message?.content;
  if (typeof content === "string") return content;
  return (content ?? [])
    .filter((part: { type: string }) => part?.type === "text")
    .map((part: { text: string }) => part.text)
    .join(" ");
}

test.use({
  seedKokoroModel: true,
  appEnv: {
    // Node refuses to spawn a .cmd without a shell on Windows, so the binary is
    // node itself and the stub script rides in on the argument-prefix hook.
    PT_CONVERSE_CLAUDE_BIN: process.execPath,
    PT_CONVERSE_CLAUDE_ARGS: JSON.stringify([STUB_PATH]),
    CLAUDE_STUB_LOG: STUB_LOG,
  },
});

test.describe("converse barge-in (headless, no microphone)", () => {
  // Cold Kokoro load plus five speak-then-interrupt cycles.
  test.setTimeout(300_000);

  test.afterAll(() => {
    fs.rmSync(STUB_LOG, { force: true });
  });

  test("an injected interrupt stops speech fast and tells the agent what was cut", async ({
    overlayWindow,
  }) => {
    // A retry must not read the previous attempt's stdin lines.
    fs.rmSync(STUB_LOG, { force: true });

    await overlayWindow.waitForFunction(() => Boolean((window as any).__converseTest), null, {
      timeout: 30_000,
    });

    const engineStatus = await overlayWindow.evaluate(
      async () => await (window as any).electronAPI.readAloudLoadEngine()
    );
    expect(engineStatus.loaded, `engine failed to load: ${engineStatus.error}`).toBe(true);

    const started: ConverseState = await overlayWindow.evaluate(
      async () =>
        await (window as any).electronAPI.converseStart({ mock: false, model: "haiku" })
    );
    expect(started.state, "session did not start in idle").toBe("idle");
    expect(started.agentMode, "the stub run must use the live agent path").toBe("live");

    const getState = (): Promise<ConverseState> =>
      overlayWindow.evaluate(async () => await (window as any).electronAPI.converseGetState());

    /** Wait, sampled inside the page, until real audio is mid-answer. */
    const waitUntilSpeaking = async (timeoutMs: number) =>
      await overlayWindow.evaluate(
        async ({ timeout, poll }) => {
          const api = (window as any).electronAPI;
          const deadline = Date.now() + timeout;
          for (;;) {
            const s = await api.converseGetState();
            const p = s?.player;
            if (
              s?.state === "speaking" &&
              p &&
              p.gen === s.turnGen &&
              p.playing === true &&
              p.playIndex >= 1
            ) {
              return { ok: true, playIndex: p.playIndex, state: s };
            }
            if (Date.now() > deadline) return { ok: false, playIndex: -1, state: s };
            await new Promise((resolve) => setTimeout(resolve, poll));
          }
        },
        { timeout: timeoutMs, poll: 25 }
      );

    /** The agent must have finished the previous turn before it accepts a new one. */
    const waitUntilAgentIdle = async (timeoutMs: number) => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const s = await getState();
        if (!s.agent?.busy) return s;
        if (Date.now() > deadline) throw new Error(`agent still busy: ${JSON.stringify(s.agent)}`);
        await sleep(25);
      }
    };

    const sendUtterance = async (text: string) =>
      await overlayWindow.evaluate(
        async (value) => await (window as any).electronAPI.converseSendUtterance(value),
        text
      );

    const stopMs: number[] = [];
    /** Per run: the scripted sentence the session believed was mid-playback. */
    const expectedCut: string[] = [];
    /** Per run: the wrapper the session was about to build, for cross-checking. */
    const expectedWrapper: { heard: string[]; cutOff: string; unheard: string[] }[] = [];

    for (let run = 0; run < RUNS; run++) {
      await waitUntilAgentIdle(30_000);

      const accepted = await sendUtterance(LONG_UTTERANCE);
      expect(accepted.accepted, `run ${run + 1}: utterance refused (${accepted.reason})`).toBe(true);

      const speaking = await waitUntilSpeaking(60_000);
      expect(
        speaking.ok,
        `run ${run + 1}: never reached mid-speech (state: ${speaking.state?.state}, player: ${JSON.stringify(speaking.state?.player)})`
      ).toBe(true);

      // Nothing between t0 and the interrupt call but the call itself.
      const t0 = Date.now();
      const interrupted = await overlayWindow.evaluate(
        async (reason) => await (window as any).electronAPI.converseInterrupt(reason),
        "test barge-in"
      );
      const newGen = interrupted.turnGen as number;

      let t1 = 0;
      for (;;) {
        const s = await getState();
        const p = s.player;
        // The post-interrupt generation is what makes this a real stop rather
        // than the momentary gap between two sentences.
        if (p && p.gen === newGen && p.playing === false) {
          t1 = Date.now();
          break;
        }
        if (Date.now() - t0 > 5_000) {
          throw new Error(
            `run ${run + 1}: playback never reported stopped (player: ${JSON.stringify(p)})`
          );
        }
        await sleep(POLL_MS);
      }

      const elapsed = t1 - t0;
      stopMs.push(elapsed);

      expect(
        interrupted.from,
        `run ${run + 1}: interrupt did not land while speaking (was ${interrupted.from})`
      ).toBe("speaking");
      expect(elapsed, `run ${run + 1}: playback took ${elapsed}ms to stop`).toBeLessThan(
        STOP_BUDGET_MS
      );

      const after = await getState();

      const transition = (after.stateLog ?? []).some(
        (entry) => entry.state === "listening" && entry.reason === "interrupt: test barge-in"
      );
      expect(transition, `run ${run + 1}: no interrupt transition in the state log`).toBe(true);

      const pending = after.pendingInterrupt;
      expect(pending, `run ${run + 1}: no interruption context was recorded`).toBeTruthy();
      expect(pending!.cutOff, `run ${run + 1}: no cut-off sentence recorded`).toBeTruthy();
      expect(
        pending!.heard.length,
        `run ${run + 1}: nothing was recorded as heard`
      ).toBeGreaterThanOrEqual(1);
      expect(
        pending!.unheard.length,
        `run ${run + 1}: nothing was recorded as never spoken`
      ).toBeGreaterThanOrEqual(1);

      // The session's idea of the cut sentence has to be the stub's scripted
      // sentence at the index the renderer was actually playing.
      const idx = after.lastInterrupt?.playerWas?.playIndex;
      expect(
        idx,
        `run ${run + 1}: interrupt was recorded against sentence ${idx}, not mid-answer`
      ).toBeGreaterThanOrEqual(1);
      expect(idx, `run ${run + 1}: player position past the scripted answer`).toBeLessThan(
        STUB_SENTENCES.length
      );
      expect(
        pending!.cutOff,
        `run ${run + 1}: cut sentence is not the scripted sentence at index ${idx}`
      ).toBe(STUB_SENTENCES[idx as number]);

      expectedCut.push(STUB_SENTENCES[idx as number]);
      expectedWrapper.push({
        heard: pending!.heard.slice(),
        cutOff: pending!.cutOff as string,
        unheard: pending!.unheard.slice(),
      });
    }

    // Close the last interruption with one more utterance, so all five runs are
    // followed by a prompt that must carry the wrapper.
    await waitUntilAgentIdle(30_000);
    const lastAccepted = await sendUtterance(FINAL_UTTERANCE);
    expect(lastAccepted.accepted, `final utterance refused (${lastAccepted.reason})`).toBe(true);

    // The stub writes each stdin line before answering it, so the file settles
    // as soon as the app has sent all six.
    const expectedLines = RUNS + 1;
    const deadline = Date.now() + 15_000;
    let lines = readStubUserLines();
    while (lines.length < expectedLines && Date.now() < deadline) {
      await sleep(50);
      lines = readStubUserLines();
    }
    expect(
      lines.length,
      `the agent process received ${lines.length} stdin lines, expected ${expectedLines}`
    ).toBe(expectedLines);

    const texts = lines.map(textOfStubLine);

    // The first utterance had nothing to be interrupted about.
    expect(texts[0], "the first prompt should not carry an interruption wrapper").toBe(
      LONG_UTTERANCE
    );

    const wrapperLines: string[] = [];
    for (let run = 0; run < RUNS; run++) {
      const text = texts[run + 1];
      const utterance = run + 1 < RUNS ? LONG_UTTERANCE : FINAL_UTTERANCE;
      const want = expectedWrapper[run];

      expect(text.startsWith("[You were interrupted mid-answer."), `run ${run + 1}: ${text}`).toBe(
        true
      );
      expect(text, `run ${run + 1}: wrapper does not quote the cut sentence`).toContain(
        `You were cut off during: "${expectedCut[run]}"`
      );
      expect(text, `run ${run + 1}: wrapper does not list what was heard`).toContain(
        `The user heard: "${want.heard.join(" ")}"`
      );
      expect(text, `run ${run + 1}: wrapper does not list what was never spoken`).toContain(
        `Never spoken: "${want.unheard.join(" ")}"`
      );
      // Heard and never-spoken must be real sentences from the script, so the
      // wrapper cannot pass by being empty on either side.
      expect(want.heard[0], `run ${run + 1}: heard list is not scripted text`).toBe(
        STUB_SENTENCES[0]
      );
      expect(
        want.unheard[want.unheard.length - 1],
        `run ${run + 1}: never-spoken list is not scripted text`
      ).toBe(STUB_SENTENCES[STUB_SENTENCES.length - 1]);
      expect(text.endsWith(utterance), `run ${run + 1}: raw utterance missing: ${text}`).toBe(true);

      wrapperLines.push(text);
    }

    const finalState = await getState();
    expect(
      finalState.agentMode,
      `agent fell back to mock (lastError: ${finalState.lastError})`
    ).toBe("live");

    // Single lines, straight into the ledger.
    console.log(`BARGEIN_STOP_MS=[${stopMs.join(", ")}]`);
    console.log(`BARGEIN_WRAPPER_OK=true`);
    console.log(`BARGEIN_WRAPPER_LINE=${wrapperLines[0].slice(0, 200)}`);

    const stopped: ConverseState = await overlayWindow.evaluate(
      async () => await (window as any).electronAPI.converseStop()
    );
    expect(stopped.running, "session still running after stop").toBe(false);
  });
});
