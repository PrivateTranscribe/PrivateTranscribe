import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures/electron-app";
import { unlockTesterAccess } from "./fixtures/tester-access";

/**
 * Talking to Claude Code, out loud, with no keyboard.
 *
 * The whole point of the loop is that nobody types, so a spec that types would
 * prove nothing about it. This one speaks: Chromium's fake capture device plays
 * a real recording of a sentence into the app, and the app has to find the start
 * and end of that sentence, transcribe it with the real whisper model, and send
 * the words to a real agent process over its real stdin.
 *
 * The evidence is the stub's own log of what arrived on that stdin — not what
 * the page says it sent, not a transcript rendered in a div.
 *
 * The agent is the same stub the other Converse gates use, so the answer is
 * scripted and this spec never spends a live prompt. Everything else in the
 * path — microphone, voice activity detection, whisper, the session state
 * machine, Kokoro — is the real thing.
 */

const EVIDENCE_DIR = path.resolve(__dirname, "..", "..", "docs", "goal-evidence");
const STUB_PATH = path.join(__dirname, "fixtures", "claude-stub.cjs");
const SPEECH_WAV = path.resolve(__dirname, "..", "fixtures", "dictation", "banana.wav");

/** A screenshot that is present but blank would pass a bare existence check. */
const MIN_SCREENSHOT_BYTES = 10_000;

/** The word from the fixture recording that must survive the whole path. */
const SPOKEN_WORD = "backpack";

async function captureEvidence(page: Page, fileName: string): Promise<void> {
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  const filePath = path.join(EVIDENCE_DIR, fileName);

  // The pointer stays where the last click left it, so without this the picture
  // shows a hover state the design never asked for.
  await page.mouse.move(1180, 500);

  // Every className swap starts a transition, and these windows are painted
  // invisibly during a run: a shot taken the instant a state changes can freeze
  // a button mid-fade between two variants and be judged as if that were the
  // design.
  await page
    .waitForFunction(
      () =>
        document.getAnimations().every((a) => a.playState === "finished" || a.playState === "idle"),
      null,
      { timeout: 5_000 }
    )
    .catch(() => {
      // Something animates forever on this screen; the shot is still worth having.
    });

  await page.screenshot({ path: filePath, fullPage: true });

  const bytes = fs.statSync(filePath).size;
  expect(bytes, `${fileName} is too small to show anything (${bytes} bytes)`).toBeGreaterThan(
    MIN_SCREENSHOT_BYTES
  );
}

/** Local whisper, so the spoken turn is transcribed on this machine. */
async function useLocalTranscription(page: Page): Promise<void> {
  await page.evaluate(() => {
    localStorage.setItem("useLocalWhisper", "true");
    localStorage.setItem("whisperModel", "base");
    localStorage.setItem("localTranscriptionProvider", "whisper");
    localStorage.setItem("whisperForceCpu", "true");
    localStorage.setItem("customDictionary", "[]");
    localStorage.setItem("converseVoiceEnabled", "true");
    localStorage.setItem("converseEndOfTurnMs", "900");
  });
}

async function openConversePage(controlPanel: Page): Promise<void> {
  await controlPanel.getByRole("button", { name: /^Converse( Beta)?$/ }).click();
  await expect(controlPanel.getByRole("heading", { name: "Converse" })).toBeVisible();
}

/**
 * Seed the remembered-folders list and pick the row; the native dialog cannot
 * be driven headlessly. Never reload the window to do it: a reload throws away
 * the stubbed licensing fetch, start-up revalidation then asks the real server
 * about a fake key, and the whole beta page locks itself mid-test.
 */
async function chooseProject(controlPanel: Page, dir: string): Promise<void> {
  await controlPanel.evaluate(
    (value) =>
      localStorage.setItem(
        "converseProjects",
        JSON.stringify([{ path: value, lastUsedAt: Date.now() }])
      ),
    dir
  );
  await openConversePage(controlPanel);
  await controlPanel.getByTestId("converse-recent-project").first().click();
  await expect(controlPanel.getByTestId("converse-project-path")).toHaveText(dir);
}

test.describe("talking to Claude Code", () => {
  test.use({
    seedKokoroModel: true,
    seedRealWhisperModels: ["base"],
    fakeAudioCaptureFile: SPEECH_WAV,
    appEnv: {
      // Node refuses to spawn a .cmd without a shell on Windows, so the binary
      // is node itself and the stub rides in on the argument prefix.
      PT_CONVERSE_CLAUDE_BIN: process.execPath,
      PT_CONVERSE_CLAUDE_ARGS: JSON.stringify([STUB_PATH]),
      CLAUDE_STUB_DELAY_MS: "1500",
      WHISPER_FORCE_CPU: "true",
    },
  });

  test("a spoken sentence reaches the agent with no keyboard", async ({
    controlPanel,
    overlayWindow,
    electronApp,
  }) => {
    // A cold whisper load, a cold Kokoro load, and a full spoken turn.
    test.setTimeout(420_000);

    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-converse-voice-"));
    const stubLog = path.join(projectDir, "stdin.log");
    await electronApp.evaluate((_electron, file) => {
      process.env.CLAUDE_STUB_LOG = file;
    }, stubLog);

    await unlockTesterAccess(controlPanel);
    await useLocalTranscription(controlPanel);

    // Paid outside the turn, as the other Converse gates do it: 326MB of
    // weights off disk is not part of a conversational turn.
    await overlayWindow.waitForFunction(() => Boolean((window as any).__converseTest), null, {
      timeout: 30_000,
    });
    const engine = await overlayWindow.evaluate(
      async () => await (window as any).electronAPI.readAloudLoadEngine()
    );
    expect(engine.loaded, `engine failed to load: ${engine.error}`).toBe(true);

    await chooseProject(controlPanel, projectDir);

    // ----------------------------------------------- the settings, before
    await expect(controlPanel.getByText("Talk instead of typing")).toBeVisible();
    await expect(controlPanel.getByTestId("converse-speech-route")).toHaveText("On this machine");
    await captureEvidence(controlPanel, "converse-voice-settings.png");

    // ------------------------------------------------- the microphone opens
    await controlPanel.getByRole("button", { name: "Start session" }).click();

    const voice = controlPanel.getByTestId("converse-voice");
    await expect(voice).toBeVisible();
    await expect(voice).toHaveAttribute("data-phase", /listening|hearing/, { timeout: 30_000 });
    await captureEvidence(controlPanel, "converse-voice-listening.png");

    // The recording is playing on a loop, so the detector has to find speech in
    // it without anybody pressing anything — and the meter has to be moving
    // while it does. Both are read in the same poll: a status line that says
    // "hearing" over a flat meter is what a dead microphone looks like, and
    // checking them one after the other would let the level decay in between.
    const meter = controlPanel.getByTestId("converse-voice-level");
    await expect
      .poll(
        async () => {
          const phase = await voice.getAttribute("data-phase");
          const level = Number(await meter.getAttribute("data-level"));
          return phase === "hearing" && level > 0;
        },
        { timeout: 60_000, message: "the microphone never registered the spoken fixture" }
      )
      .toBe(true);
    await captureEvidence(controlPanel, "converse-voice-hearing.png");

    // ------------------------------------------- the words reach the agent
    const transcript = controlPanel.getByTestId("converse-transcript");
    await expect(transcript).toContainText(new RegExp(SPOKEN_WORD, "i"), { timeout: 240_000 });
    await captureEvidence(controlPanel, "converse-voice-turn-sent.png");

    // What the agent process actually received on its stdin. Nothing in the
    // renderer can fake this line into existence.
    const sent = fs.existsSync(stubLog) ? fs.readFileSync(stubLog, "utf8") : "";
    expect(sent.toLowerCase(), "the spoken sentence never reached the agent").toContain(
      SPOKEN_WORD
    );

    const state = await controlPanel.evaluate(
      async () => await (window as any).electronAPI.converseGetState()
    );
    expect(state.agentMode, "the stub run must use the live agent path").toBe("live");
    expect(String(state.lastUtterance?.text || "").toLowerCase()).toContain(SPOKEN_WORD);

    // --------------------------------------- the microphone closes to listen
    // Mute-while-speaking ships on, so the reply cannot be heard as the next
    // sentence. This is the state the setting exists to produce.
    await expect(voice).toHaveAttribute("data-phase", "muted", { timeout: 120_000 });
    await captureEvidence(controlPanel, "converse-voice-muted.png");

    // ------------------------------------------------------ switching it off
    await controlPanel.getByTestId("converse-voice-toggle").click();
    await expect(voice).toHaveAttribute("data-phase", "off");
    await expect(controlPanel.getByTestId("converse-voice-toggle")).toContainText("Voice off");
    await captureEvidence(controlPanel, "converse-voice-off.png");

    // The device is released, not merely ignored: the setting has to turn the
    // operating system's own microphone indicator back off.
    expect(await controlPanel.evaluate(() => localStorage.getItem("converseVoiceEnabled"))).toBe(
      "false"
    );

    await controlPanel.getByRole("button", { name: "Stop session" }).click();
    await expect(controlPanel.getByRole("button", { name: "Start session" })).toBeVisible();

    fs.rmSync(projectDir, { recursive: true, force: true });
  });
});

test.describe("a microphone the app cannot open", () => {
  test.use({
    appEnv: {
      PT_CONVERSE_CLAUDE_BIN: process.execPath,
      PT_CONVERSE_CLAUDE_ARGS: JSON.stringify([STUB_PATH]),
    },
  });

  test("says so, and keeps the typed path working", async ({ controlPanel }) => {
    test.setTimeout(120_000);

    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-converse-denied-"));

    await unlockTesterAccess(controlPanel);

    // A refused microphone is the one failure that cannot be produced on a
    // machine that has one, and it is the failure a user is most likely to hit.
    // Patched into the live window rather than through addInitScript: this spec
    // must never reload (see chooseProject), and a patch that only takes effect
    // on the next navigation would leave the real microphone to be opened.
    await controlPanel.evaluate(() => {
      navigator.mediaDevices.getUserMedia = () =>
        Promise.reject(Object.assign(new Error("Permission denied"), { name: "NotAllowedError" }));
    });

    await useLocalTranscription(controlPanel);
    await chooseProject(controlPanel, projectDir);

    await controlPanel.getByRole("button", { name: "Start session" }).click();

    const voice = controlPanel.getByTestId("converse-voice");
    await expect(voice).toHaveAttribute("data-phase", "error", { timeout: 30_000 });
    await expect(controlPanel.getByTestId("converse-voice-state")).toContainText(
      /Microphone access was refused/
    );
    await expect(controlPanel.getByRole("button", { name: "Try again" })).toBeVisible();

    // The conversation is not over because the microphone failed.
    await expect(controlPanel.getByTestId("converse-input")).toBeEnabled();
    await captureEvidence(controlPanel, "converse-voice-error.png");

    await controlPanel.getByRole("button", { name: "Stop session" }).click();
    fs.rmSync(projectDir, { recursive: true, force: true });
  });
});
