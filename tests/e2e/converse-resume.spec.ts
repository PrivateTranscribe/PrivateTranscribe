import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "./fixtures/electron-app";

test.use({ experimentalFeatures: true });

/**
 * Ledger gate `converse-session-resume`: a conversation survives the app being
 * closed.
 *
 * Turn one plants a nonce word. The app is then RESTARTED — a real process
 * exit, a real new process, the same userData directory — and turn two asks for
 * the word back. Two things have to hold at once:
 *
 *   1. the reply contains the nonce, so the agent really carried the context
 *      across the restart rather than the app replaying its own transcript, and
 *   2. the session id in the app's state is identical either side of the
 *      restart, so the continuity is the CLI's session and not a coincidence.
 *
 * The nonce lives only here. Neither the app nor the stub knows it: the stub's
 * memory is a generic "remember the word X" / "what is the word" mechanism, so
 * a passing run cannot be a hardcoded answer.
 *
 * Modes, exactly as converse-loop.spec.ts does it:
 *
 *   PT_CONVERSE_E2E_MODE=mock  (default) the stub `claude` over the app's real
 *                              live path — real spawn, real stream-json, real
 *                              `--resume`. No live prompt spent, no network.
 *   PT_CONVERSE_E2E_MODE=live  the real `claude` CLI. Two prompts.
 *
 * Both modes run `mock: false` and both FAIL if the session ever reports agent
 * mode "mock": a canned reply must never close this gate.
 */

const MODE = process.env.PT_CONVERSE_E2E_MODE === "live" ? "live" : "mock";

const STUB_PATH = path.join(__dirname, "fixtures", "claude-stub.cjs");
const RUN_ID = `${process.pid}-${Date.now()}`;
const STUB_LOG = path.join(os.tmpdir(), `pt-converse-resume-${RUN_ID}.log`);
/** Survives the restart on purpose: it is the stub's cross-process memory. */
const STUB_STATE = path.join(os.tmpdir(), `pt-converse-resume-state-${RUN_ID}`);

/** Known to this file only. */
const NONCE = "grobblewurst";
const PLANT_UTTERANCE = `Please remember the word ${NONCE}.`;
const RECALL_UTTERANCE = "What is the word I asked you to remember?";

const TURN_TIMEOUT_MS = MODE === "live" ? 90_000 : 20_000;
const POLL_MS = 25;

type ConverseState = {
  state: string;
  agentMode?: string;
  sessionId?: string | null;
  resumedFrom?: string | null;
  cwd?: string;
  lastError?: string | null;
  lastResponse?: { text: string; sentences: string[] } | null;
  running?: boolean;
};

const stubEnv =
  MODE === "mock"
    ? {
        // Node refuses to spawn a .cmd without a shell on Windows, so the
        // binary is node itself and the stub rides in on the argument prefix.
        PT_CONVERSE_CLAUDE_BIN: process.execPath,
        PT_CONVERSE_CLAUDE_ARGS: JSON.stringify([STUB_PATH]),
        CLAUDE_STUB_LOG: STUB_LOG,
        CLAUDE_STUB_STATE: STUB_STATE,
      }
    : {};

test.use({ seedKokoroModel: true, appEnv: stubEnv });

test.describe("converse session resume across an app restart", () => {
  // Two cold Kokoro loads, two app launches, two full turns.
  test.setTimeout(MODE === "live" ? 360_000 : 300_000);

  test.afterAll(() => {
    fs.rmSync(STUB_LOG, { force: true });
    fs.rmSync(STUB_STATE, { recursive: true, force: true });
  });

  test(`the word planted before the restart comes back after it (${MODE} mode)`, async ({
    overlayWindow,
    relaunchElectronApp,
    userDataDir,
  }) => {
    // A retry must not inherit the previous attempt's stub memory.
    fs.rmSync(STUB_LOG, { force: true });
    fs.rmSync(STUB_STATE, { recursive: true, force: true });

    /** Everything a turn needs, against whichever window is currently live. */
    const driver = (page: typeof overlayWindow) => ({
      async ready() {
        await page.waitForFunction(() => Boolean((window as any).__converseTest), null, {
          timeout: 30_000,
        });
        const engine = await page.evaluate(
          async () => await (window as any).electronAPI.readAloudLoadEngine()
        );
        expect(engine.loaded, `engine failed to load: ${engine.error}`).toBe(true);
      },
      async start(options: Record<string, unknown>): Promise<ConverseState> {
        return await page.evaluate(
          async (opts) => await (window as any).electronAPI.converseStart(opts),
          options
        );
      },
      async say(text: string) {
        return await page.evaluate(
          async (value) => await (window as any).electronAPI.converseSendUtterance(value),
          text
        );
      },
      /** Polled inside the page, so the sampling is not one IPC hop per tick. */
      async waitForTurn(timeoutMs: number): Promise<{ timedOut: boolean; state: ConverseState }> {
        return await page.evaluate(
          async ({ timeout, poll }) => {
            const api = (window as any).electronAPI;
            const deadline = Date.now() + timeout;
            for (;;) {
              const state = await api.converseGetState();
              if (state?.state === "listening") return { timedOut: false, state };
              if (Date.now() > deadline) return { timedOut: true, state };
              await new Promise((resolve) => setTimeout(resolve, poll));
            }
          },
          { timeout: timeoutMs, poll: POLL_MS }
        );
      },
      async state(): Promise<ConverseState> {
        return await page.evaluate(
          async () => await (window as any).electronAPI.converseGetState()
        );
      },
    });

    // ---------------------------------------------------------- before the restart

    const first = driver(overlayWindow);
    await first.ready();

    const started = await first.start({ mock: false, model: "haiku" });
    expect(started.state, "session did not start in idle").toBe("idle");
    expect(started.agentMode, "the run must use the live agent path").toBe("live");
    expect(started.resumedFrom, "a fresh session must not claim to have resumed").toBeFalsy();

    const planted = await first.say(PLANT_UTTERANCE);
    expect(planted.accepted, `plant utterance refused: ${planted.reason}`).toBe(true);

    const plantTurn = await first.waitForTurn(TURN_TIMEOUT_MS);
    expect(
      plantTurn.timedOut,
      `plant turn never returned to listening (state: ${plantTurn.state?.state}, error: ${plantTurn.state?.lastError})`
    ).toBe(false);

    const sessionIdA = plantTurn.state.sessionId;
    expect(sessionIdA, "the CLI never announced a session id").toBeTruthy();

    // The id has to be on disk, not just in memory, or nothing can resume it.
    const storeFile = path.join(userDataDir, "converse-sessions.json");
    expect(fs.existsSync(storeFile), `no session store written at ${storeFile}`).toBe(true);
    const store = JSON.parse(fs.readFileSync(storeFile, "utf8")) as Record<
      string,
      { sessionId: string; updatedAt: number }
    >;
    const storedIds = Object.values(store).map((entry) => entry.sessionId);
    expect(storedIds, "the stored session id is not the one the session reported").toContain(
      sessionIdA
    );

    // ---------------------------------------------------------------- the restart

    const relaunched = await relaunchElectronApp();
    // Only a spec that disables the overlay gets null back, and this one needs it.
    if (!relaunched.overlayWindow) throw new Error("the relaunched app has no overlay window");
    const second = driver(relaunched.overlayWindow);
    await second.ready();

    const resumed = await second.start({ mock: false, model: "haiku", resume: true });
    expect(resumed.agentMode, "the resumed run must use the live agent path").toBe("live");
    expect(resumed.resumedFrom, "the new instance did not resume the stored session").toBe(
      sessionIdA
    );
    expect(resumed.sessionId, "the resumed session reports a different id").toBe(sessionIdA);

    // ----------------------------------------------------------- after the restart

    const asked = await second.say(RECALL_UTTERANCE);
    expect(asked.accepted, `recall utterance refused: ${asked.reason}`).toBe(true);

    const recallTurn = await second.waitForTurn(TURN_TIMEOUT_MS);
    expect(
      recallTurn.timedOut,
      `recall turn never returned to listening (state: ${recallTurn.state?.state}, error: ${recallTurn.state?.lastError})`
    ).toBe(false);

    const finalState = await second.state();
    const reply = finalState.lastResponse?.text ?? "";

    // Single lines, straight into the ledger.
    console.log(`RESUME_SESSION_ID=${sessionIdA}`);
    console.log(`RESUME_REPLY=${reply}`);

    expect(
      finalState.agentMode,
      `agent fell back to mock (lastError: ${finalState.lastError})`
    ).toBe("live");
    expect(finalState.sessionId, "the session id changed during the resumed turn").toBe(sessionIdA);
    expect(reply.toLowerCase(), `the reply does not contain the planted word: ${reply}`).toContain(
      NONCE
    );

    const stopped: ConverseState = await relaunched.overlayWindow.evaluate(
      async () => await (window as any).electronAPI.converseStop()
    );
    expect(stopped.running, "session still running after stop").toBe(false);
  });
});
