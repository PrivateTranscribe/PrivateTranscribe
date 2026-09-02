import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "./fixtures/electron-app";
import { unlockTesterAccess } from "./fixtures/tester-access";
import type { Page } from "@playwright/test";

/**
 * Ledger gate `converse-ui`: the Converse page and the overlay's conversation
 * state exist, are beta gated, and survive a blind design review.
 *
 * Every state the UI can be in gets a screenshot in docs/goal-evidence/,
 * because a critic reads them afterwards and a state with no picture is a state
 * nobody judged: locked, no project chosen, a project chosen but not started,
 * and then the live session in idle / thinking / speaking / after-interrupt,
 * plus the overlay pill while it speaks.
 *
 * No microphone and no live Claude prompt is involved. The agent is the same
 * stub `claude` the barge-in gate uses (tests/e2e/fixtures/claude-stub.cjs),
 * spoken to over the real live path — real spawn, real stream-json, real turn
 * accounting, scripted answer. It is preferred over mock mode here because the
 * screenshots have to catch `thinking`, and the stub's CLAUDE_STUB_DELAY_MS
 * makes that state last long enough to photograph deterministically; mock
 * mode's first delta lands after 150ms. Everything else in the loop — Kokoro,
 * the splitter, the queue player, the state machine — is the real one.
 */

const EVIDENCE_DIR = path.resolve(__dirname, "..", "..", "docs", "goal-evidence");
const STUB_PATH = path.join(__dirname, "fixtures", "claude-stub.cjs");

/** A screenshot that is present but blank would pass a bare existence check. */
const MIN_SCREENSHOT_BYTES = 10_000;

/**
 * How long the stub waits before its first token. Long enough that `thinking`
 * survives being detected, waited on for the page to settle, and photographed.
 */
const THINKING_DELAY_MS = 4000;

/**
 * Gap between the stub's text deltas. Sixteen chunks at this rate means the
 * eight-sentence answer takes about six seconds to arrive, which is the only
 * way to prove the transcript renders a reply while it is still being written
 * rather than after the turn ends. Playback of eight spoken sentences takes
 * far longer than that, so generation still finishes first.
 */
const DELTA_GAP_MS = 400;

/** Contains the stub's long-answer marker, so the reply is eight sentences. */
const LONG_UTTERANCE = "Tell me everything about this project.";

/** Must stay in step with STATE_LABELS in ConversePage.tsx. */
const STATE_LABELS: Record<string, string> = {
  idle: "Idle",
  thinking: "Thinking",
  speaking: "Speaking",
  listening: "Listening",
};

async function captureEvidence(
  page: Page,
  fileName: string,
  { minBytes = MIN_SCREENSHOT_BYTES, parkMouse = true } = {}
) {
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  const filePath = path.join(EVIDENCE_DIR, fileName);

  // The pointer stays wherever the last click left it, so without this the
  // evidence shows a hover state on whatever was clicked last — a critic would
  // be judging a highlight the design never asked for. The park position is
  // empty margin to the right of the content column.
  if (parkMouse) await page.mouse.move(1180, 500);

  // Every className swap starts a 150ms transition. These windows are painted
  // invisibly during a run and get very few frames, so a screenshot taken the
  // instant a state changes can freeze a half-finished transition that no user
  // would ever see — a button caught mid-fade between two variants, judged as
  // if that were the design. Wait for the page to stop animating first.
  await page
    .waitForFunction(
      () =>
        document
          .getAnimations()
          .every(
            (animation) => animation.playState === "finished" || animation.playState === "idle"
          ),
      null,
      { timeout: 5_000 }
    )
    .catch(() => {
      // Something animates forever on this screen; the screenshot is still
      // worth having.
    });

  await page.screenshot({ path: filePath, fullPage: true });

  expect(fs.existsSync(filePath), `${fileName} was not written`).toBe(true);
  const bytes = fs.statSync(filePath).size;
  expect(bytes, `${fileName} is too small to show anything (${bytes} bytes)`).toBeGreaterThan(
    minBytes
  );
  return filePath;
}

/** The sidebar entry drops its "Beta" badge once tester access is active. */
async function openConversePage(controlPanel: Page) {
  await controlPanel.getByRole("button", { name: /^Converse( Beta)?$/ }).click();
  await expect(controlPanel.getByRole("heading", { name: "Converse" })).toBeVisible();
}

/**
 * The status line must be the session's own state, not the page's guess at it.
 * Both are read inside one poll so a legitimate transition cannot be mistaken
 * for a disagreement.
 */
async function expectStatusMatchesSession(controlPanel: Page, expected: string) {
  const status = controlPanel.getByTestId("converse-status");

  await expect
    .poll(
      async () => {
        const live = await controlPanel.evaluate(
          async () => (await (window as any).electronAPI.converseGetState()).state
        );
        const shown = await status.getAttribute("data-state");
        return shown === live ? live : `page says ${shown}, session says ${live}`;
      },
      { timeout: 10_000, message: `status line never settled on ${expected}` }
    )
    .toBe(expected);

  await expect(status).toContainText(STATE_LABELS[expected]);
}

test.describe("converse ui", () => {
  test("shows the locked beta state with a way out", async ({ controlPanel }) => {
    await openConversePage(controlPanel);

    await expect(controlPanel.getByText("Beta", { exact: true }).first()).toBeVisible();
    await expect(
      controlPanel.getByRole("button", { name: /Apply for early access/ })
    ).toBeVisible();

    // Locked means locked: no folder picker and no session controls are
    // reachable from here.
    await expect(controlPanel.getByRole("button", { name: /Choose a project folder/ })).toHaveCount(
      0
    );
    await expect(controlPanel.getByRole("button", { name: "Start session" })).toHaveCount(0);

    await captureEvidence(controlPanel, "converse-page-locked.png");
  });

  test("explains itself before a folder is chosen", async ({ controlPanel }) => {
    await unlockTesterAccess(controlPanel);
    await openConversePage(controlPanel);

    await expect(
      controlPanel.getByRole("button", { name: /Choose a project folder/ })
    ).toBeVisible();
    await expect(
      controlPanel.getByText(/Claude Code runs inside the folder you choose/)
    ).toBeVisible();

    // Nothing has been chosen yet, so there is nothing to remember.
    await expect(controlPanel.getByTestId("converse-recent-project")).toHaveCount(0);
    await expect(controlPanel.getByRole("button", { name: "Start session" })).toHaveCount(0);

    await captureEvidence(controlPanel, "converse-page-no-project.png");
  });

  test.describe("with a project folder and the stub agent", () => {
    test.use({
      seedKokoroModel: true,
      appEnv: {
        // Node refuses to spawn a .cmd without a shell on Windows, so the
        // binary is node itself and the stub rides in on the argument prefix.
        PT_CONVERSE_CLAUDE_BIN: process.execPath,
        PT_CONVERSE_CLAUDE_ARGS: JSON.stringify([STUB_PATH]),
        CLAUDE_STUB_DELAY_MS: String(THINKING_DELAY_MS),
        CLAUDE_STUB_DELTA_GAP_MS: String(DELTA_GAP_MS),
      },
    });

    test("runs a session and shows every live state", async ({ controlPanel, overlayWindow }) => {
      // A cold Kokoro load plus a full spoken turn.
      test.setTimeout(300_000);

      const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-converse-project-"));

      // The native folder dialog cannot be driven headlessly, so the spec seeds
      // the remembered-folders list the picker writes and clicks the row. The
      // dialog IPC is still what a real user goes through.
      await controlPanel.evaluate(
        (dir) =>
          localStorage.setItem(
            "converseProjects",
            JSON.stringify([{ path: dir, lastUsedAt: Date.now() }])
          ),
        projectDir
      );

      await unlockTesterAccess(controlPanel);

      // Paid outside the turn, exactly as the converse-loop gate does it: 326MB
      // of weights off disk is not part of a conversational turn.
      await overlayWindow.waitForFunction(() => Boolean((window as any).__converseTest), null, {
        timeout: 30_000,
      });
      const engineStatus = await overlayWindow.evaluate(
        async () => await (window as any).electronAPI.readAloudLoadEngine()
      );
      expect(engineStatus.loaded, `engine failed to load: ${engineStatus.error}`).toBe(true);

      await openConversePage(controlPanel);

      // ---------------------------------------------------- project chosen
      await controlPanel.getByTestId("converse-recent-project").first().click();
      await expect(controlPanel.getByTestId("converse-project-path")).toHaveText(projectDir);
      await expect(controlPanel.getByText(/Headphones recommended/)).toBeVisible();

      // Mute-while-speaking ships on, and the stored preference has to say so.
      expect(
        await controlPanel.evaluate(() => localStorage.getItem("converseMuteWhileSpeaking"))
      ).toBe("true");

      await captureEvidence(controlPanel, "converse-page-project-ready.png");

      // ------------------------------------------------------------- idle
      await controlPanel.getByRole("button", { name: "Start session" }).click();
      await expectStatusMatchesSession(controlPanel, "idle");
      await captureEvidence(controlPanel, "converse-page-idle.png");

      // --------------------------------------------------------- thinking
      await controlPanel.getByTestId("converse-input").fill(LONG_UTTERANCE);
      await controlPanel.getByRole("button", { name: "Send", exact: true }).click();

      await expectStatusMatchesSession(controlPanel, "thinking");
      // The message is in the transcript before any answer exists.
      await expect(controlPanel.getByTestId("converse-transcript")).toContainText(LONG_UTTERANCE);
      await captureEvidence(controlPanel, "converse-page-thinking.png");

      // --------------------------------------------------------- speaking
      const status = controlPanel.getByTestId("converse-status");
      await expect(status).toHaveAttribute("data-state", "speaking", { timeout: 60_000 });
      await expectStatusMatchesSession(controlPanel, "speaking");

      // The transcript fills in as the reply arrives, not once the turn ends.
      // With the stub slowed to a human writing speed, the first sentence is on
      // screen while the last one has not been generated yet — a page that only
      // rendered finished turns would fail the first line, and one that waited
      // for turn end would fail the second.
      const transcript = controlPanel.getByTestId("converse-transcript");
      await expect(transcript).toContainText("Stub sentence one.");
      await expect(transcript).not.toContainText("Stub sentence eight.");
      await captureEvidence(controlPanel, "converse-page-speaking.png");

      // ------------------------------------------------- overlay, speaking
      const pill = overlayWindow.getByTestId("converse-overlay-state");
      await expect(pill).toBeVisible({ timeout: 30_000 });
      // Subject and state in one phrase, nothing else.
      await expect(pill).toContainText("Claude Code speaking");
      await expect(
        overlayWindow.getByRole("button", { name: "Interrupt Claude Code" })
      ).toBeVisible();

      // Progress, so the listener knows how much is left. It appears
      // only once the answer has stopped growing — the eighth sentence being on
      // screen is what says the count is final — and playback is still several
      // sentences behind at that point.
      await expect(transcript).toContainText("Stub sentence eight.", { timeout: 20_000 });
      await expect(overlayWindow.getByTestId("converse-progress")).toHaveAttribute(
        "data-position",
        /^\d+\/8$/
      );
      // The overlay is 400x500 and mostly transparent, so its screenshot is an
      // order of magnitude smaller than a full page — and the pointer must stay
      // off it, since hovering the overlay makes the app take mouse events.
      await captureEvidence(overlayWindow, "converse-overlay-speaking.png", { parkMouse: false });

      // --------------------------------------------------- after interrupt
      // The whole answer is written by now but only a few sentences of it have
      // been spoken, so the cut has something on both sides: what the user
      // heard, and what was written and never said out loud.
      await expect(status).toHaveAttribute("data-state", "speaking");
      await controlPanel.getByRole("button", { name: "Interrupt" }).click();

      await expect(controlPanel.getByTestId("converse-cut-marker")).toBeVisible();
      await expectStatusMatchesSession(controlPanel, "listening");
      await expect(transcript).toContainText("Stub sentence one.");
      await captureEvidence(controlPanel, "converse-page-after-interrupt.png");

      const afterInterrupt = await controlPanel.evaluate(
        async () => await (window as any).electronAPI.converseGetState()
      );
      // The stub run must never be mistaken for mock mode, and the cut has to
      // be the session's own record of a real interruption mid-speech.
      expect(afterInterrupt.agentMode, "the stub run must use the live agent path").toBe("live");
      expect(afterInterrupt.lastInterrupt?.from).toBe("speaking");
      expect(afterInterrupt.pendingInterrupt?.cutOff).toBeTruthy();

      // The overlay drops back out of the way once nothing is being spoken.
      await expect(
        overlayWindow.getByRole("button", { name: "Interrupt Claude Code" })
      ).toHaveCount(0, { timeout: 10_000 });

      // ------------------------------------------------------------- stop
      await controlPanel.getByRole("button", { name: "Stop session" }).click();
      await expect(controlPanel.getByRole("button", { name: "Start session" })).toBeVisible();

      const stopped = await controlPanel.evaluate(
        async () => await (window as any).electronAPI.converseGetState()
      );
      expect(stopped.running, "session still running after stop").toBe(false);

      fs.rmSync(projectDir, { recursive: true, force: true });
    });
  });

  test.describe("with a project folder and a missing claude binary", () => {
    // Ledger gate `converse-binary-preflight`: ConverseAgent.start() used to
    // mark itself ready synchronously right after spawn(), so a missing
    // `claude` binary only ever surfaced as an async ENOENT after the fact —
    // converseStart had already resolved, the page had already said "Session
    // ready", and the user only learned the truth once a typed message came
    // back refused. This binary genuinely does not exist anywhere, so it
    // exercises the real preflight check rather than a stub standing in for
    // failure.
    const MISSING_BIN = path.join(
      os.tmpdir(),
      "pt-converse-preflight-missing-claude-binary-that-does-not-exist.exe"
    );

    test.use({
      seedKokoroModel: true,
      appEnv: {
        PT_CONVERSE_CLAUDE_BIN: MISSING_BIN,
      },
    });

    test("fails before any turn can be sent, naming the binary it tried", async ({
      controlPanel,
    }) => {
      const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-converse-project-"));
      await controlPanel.evaluate(
        (dir) =>
          localStorage.setItem(
            "converseProjects",
            JSON.stringify([{ path: dir, lastUsedAt: Date.now() }])
          ),
        projectDir
      );

      await unlockTesterAccess(controlPanel);
      await openConversePage(controlPanel);

      await controlPanel.getByTestId("converse-recent-project").first().click();
      await expect(controlPanel.getByTestId("converse-project-path")).toHaveText(projectDir);

      await controlPanel.getByRole("button", { name: "Start session" }).click();

      // The error must appear on this same screen, before the session UI
      // (transcript + input box) ever renders — the old bug let the input box
      // appear and only failed once something was typed into it.
      await expect(controlPanel.getByText(/Claude Code CLI not found/)).toBeVisible({
        timeout: 15_000,
      });
      await expect(controlPanel.getByText(MISSING_BIN)).toBeVisible();
      await expect(controlPanel.getByTestId("converse-input")).toHaveCount(0);
      await expect(controlPanel.getByRole("button", { name: "Start session" })).toBeVisible();

      const state = await controlPanel.evaluate(
        async () => await (window as any).electronAPI.converseGetState()
      );
      expect(state.running, "a failed start must not leave a session running").toBe(false);

      await captureEvidence(controlPanel, "converse-page-start-error.png");

      fs.rmSync(projectDir, { recursive: true, force: true });
    });
  });
});
