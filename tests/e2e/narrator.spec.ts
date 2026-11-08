import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures/electron-app";

/**
 * The agent narrator, driven through the real app: a synthetic Claude Code
 * transcript is written to a folder the app watches, and the card, the
 * spoken item and the answer all come back through the real source, router,
 * IPC and overlay player.
 *
 * The rewriter runs in stub mode, so no Claude prompt is spent. The voice is
 * the real Danish Piper voice when it is downloaded on this machine (the
 * narrator's own download, or PT_E2E_NARRATOR_PIPER_DIR); without it the
 * spoken check is skipped and the card checks still run.
 */

const SESSION = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const LOCAL_ID = "local_00000000-1111-4222-8333-444444444444";
const PROJECT = "C--work-example-repo";

/**
 * Folders are named here and made in beforeAll: Playwright also loads this
 * file in its runner, which runs no test and would leave them behind.
 */
const RUN = `${process.pid}-${Date.now().toString(36)}`;
const ROOT = path.join(os.tmpdir(), `pt-e2e-narrator-projects-${RUN}`);
const SESSIONS = path.join(os.tmpdir(), `pt-e2e-narrator-sessions-${RUN}`);
const TRANSCRIPT = path.join(ROOT, PROJECT, `${SESSION}.jsonl`);
const PIPER_DIR =
  process.env.PT_E2E_NARRATOR_PIPER_DIR ||
  path.join(os.homedir(), ".cache", "PrivateTranscribe", "narrator-models", "piper-da");
const HAS_VOICE = fs.existsSync(path.join(PIPER_DIR, "model.onnx"));
/** Screenshots of each state the page shows, for review. */
const EVIDENCE = path.resolve("test-results/narrator");

const NARRATOR_ENV = {
  PT_NARRATOR_CLAUDE_DIR: ROOT,
  PT_NARRATOR_DESKTOP_SESSIONS_DIR: SESSIONS,
  PT_NARRATOR_REWRITER: "stub",
  PT_NARRATOR_PIPER_DIR: PIPER_DIR,
};

test.use({ experimentalFeatures: true, appEnv: NARRATOR_ENV });

const iso = (ms: number) => new Date(ms).toISOString();

function line(record: Record<string, unknown>): string {
  return `${JSON.stringify({ sessionId: SESSION, isSidechain: false, ...record })}\n`;
}

function writeWait(ask: string) {
  const now = Date.now();
  fs.appendFileSync(
    TRANSCRIPT,
    line({
      type: "assistant",
      timestamp: iso(now),
      entrypoint: "claude-desktop",
      message: {
        role: "assistant",
        stop_reason: "tool_use",
        content: [
          {
            type: "tool_use",
            id: "w1",
            name: "mcp__ccd_turn__wrap_up",
            input: { recap: "The export bug is fixed and four tests pass.", ask },
          },
        ],
      },
    }) +
      line({
        type: "assistant",
        timestamp: iso(now + 5),
        message: {
          role: "assistant",
          stop_reason: "end_turn",
          content: [{ type: "text", text: "Done." }],
        },
      }) +
      line({ type: "system", subtype: "stop_hook_summary", timestamp: iso(now + 10) })
  );
}

function writeAnswer() {
  fs.appendFileSync(
    TRANSCRIPT,
    line({
      type: "user",
      timestamp: iso(Date.now()),
      userType: "external",
      message: { role: "user", content: "Yes, push it." },
    })
  );
}

async function narratorState(page: Page) {
  return page.evaluate(() => window.electronAPI.narratorGetState());
}

async function capture(page: Page, name: string) {
  fs.mkdirSync(EVIDENCE, { recursive: true });
  await page.setViewportSize({ width: 1232, height: 1180 });
  await page.mouse.move(1224, 1172);
  await page.screenshot({ path: path.join(EVIDENCE, `after-${name}.png`), animations: "disabled" });
}

test.beforeAll(() => {
  fs.mkdirSync(path.join(ROOT, PROJECT), { recursive: true });
  fs.writeFileSync(
    TRANSCRIPT,
    line({ type: "custom-title", customTitle: "Example export fix" }) +
      line({
        type: "user",
        timestamp: iso(Date.now() - 1000),
        message: { role: "user", content: "fix it" },
      }) +
      // Narrator mode on: only such chats are heard by default.
      line({
        type: "assistant",
        timestamp: iso(Date.now() - 900),
        message: {
          role: "assistant",
          stop_reason: "tool_use",
          content: [{ type: "tool_use", id: "s1", name: "Skill", input: { skill: "narrator" } }],
        },
      })
  );
  fs.mkdirSync(path.join(SESSIONS, "account", "org"), { recursive: true });
  fs.writeFileSync(
    path.join(SESSIONS, "account", "org", `${LOCAL_ID}.json`),
    JSON.stringify({
      sessionId: LOCAL_ID,
      cliSessionId: SESSION,
      title: "Export fix",
      originCwd: "C:\\work\\example-repo",
      isArchived: false,
    })
  );
});

test.afterAll(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.rmSync(SESSIONS, { recursive: true, force: true });
});

test("is off by default, and a wait becomes a spoken item and a card until the user answers", async ({
  controlPanel,
}) => {
  await controlPanel.getByRole("button", { name: "Narrator", exact: true }).click();
  await expect(controlPanel.getByRole("heading", { name: "Narrator" })).toBeVisible();
  await expect(controlPanel.getByTestId("narrator-status")).toHaveText(
    "Off. Nothing is read from your chats."
  );
  expect((await narratorState(controlPanel)).running).toBe(false);
  await capture(controlPanel, "off");

  await controlPanel.getByRole("button", { name: "Narrate my Claude Code chats" }).click();
  await expect.poll(async () => (await narratorState(controlPanel)).running).toBe(true);

  writeWait("Push the fix to main?");
  const card = controlPanel.getByTestId("narrator-card");
  await expect(card).toHaveCount(1, { timeout: 10_000 });
  await expect(card).toContainText("Waits on you");
  await expect(card).toContainText("Export fix");
  await expect(card.getByRole("button", { name: "Open chat" })).toBeVisible();

  // Spoken once, at once: the item is heard and the overlay played it to the end.
  await expect
    .poll(async () => (await narratorState(controlPanel)).items[0]?.heard, { timeout: 20_000 })
    .toBe(true);
  if (HAS_VOICE) {
    await expect
      .poll(async () => (await narratorState(controlPanel)).lastPlayback?.result, {
        timeout: 20_000,
      })
      .toBe("done");
    const state = await narratorState(controlPanel);
    expect(state.voiceError).toBeNull();
    expect(state.lastPlayback?.chime).toBe(true);
    expect(state.week.interrupt).toBe(1);
    await expect(controlPanel.getByTestId("narrator-week")).toContainText("1 spoken, 1 card.");
    // The chime plays as soon as the turn is read; the words follow once they are made.
    const { chimeLatencyMs, latencyMs } = state.lastPlayback ?? {};
    console.log(
      `[narrator] chime ${chimeLatencyMs} ms, words ${latencyMs} ms after the turn ended`
    );
    expect(chimeLatencyMs).toBeLessThan(3000);
    expect(latencyMs).toBeLessThan(10_000);
  }
  await capture(controlPanel, "wait-card");

  // He answers in the chat: the card leaves.
  writeAnswer();
  await expect(card).toHaveCount(0, { timeout: 10_000 });

  // "What's new?" with nothing new says so, and still counts as a brief.
  await controlPanel.getByRole("button", { name: "What's new?" }).click();
  await expect.poll(async () => (await narratorState(controlPanel)).week.brief).toBe(1);
});

test("stays off while Experimental features are off", async ({ controlPanel }) => {
  await controlPanel.evaluate(() => window.electronAPI.narratorUpdateSettings({ enabled: true }));
  await controlPanel.evaluate(() => window.electronAPI.narratorSetGate(false));
  expect((await narratorState(controlPanel)).running).toBe(false);
  await controlPanel.evaluate(() => window.electronAPI.narratorSetGate(true));
  expect((await narratorState(controlPanel)).running).toBe(true);
});

test("gaming mode speaks only waits, turns listening off, and counts waits only with Answer by voice", async ({
  controlPanel,
  overlayWindow,
}) => {
  await controlPanel.getByRole("button", { name: "Narrator", exact: true }).click();
  await controlPanel.getByRole("button", { name: "Narrate my Claude Code chats" }).click();
  const gaming = controlPanel.getByRole("button", { name: "Gaming mode", exact: true });
  const makeRoom = controlPanel.getByRole("button", { name: "Wait for a pause in calls" });
  const listen = controlPanel.getByRole("button", { name: "Listen for questions" });
  await expect(gaming).toHaveAttribute("aria-pressed", "false");
  // Making room in a call is on by default; gaming mode is not.
  await expect(makeRoom).toHaveAttribute("aria-pressed", "true");

  await gaming.click();
  await expect.poll(async () => (await narratorState(controlPanel)).settings.gaming).toBe(true);
  await expect(gaming).toHaveAttribute("aria-pressed", "true");
  // Nothing opens the microphone: listening and stopping on speech are both off.
  await expect(listen).toBeDisabled();
  await expect(
    controlPanel.getByRole("button", { name: "Stop speaking when I talk" })
  ).toBeDisabled();
  await expect(
    controlPanel.getByText("Off while gaming mode is on.", { exact: true })
  ).toBeVisible();
  if (HAS_VOICE) {
    await expect(controlPanel.getByTestId("narrator-status")).toHaveText(
      "Gaming mode. Only waits from chats in narrator mode are spoken."
    );
  }
  await capture(controlPanel, "gaming");

  // A chat waits. With Answer by voice off the overlay stays as it always was:
  // the quiet waiting count is part of Answer by voice.
  const marker = overlayWindow.getByTestId("narrator-waiting");
  writeWait("Push the fix to main?");
  await expect
    .poll(async () => (await narratorState(controlPanel)).waiting, { timeout: 10_000 })
    .toBe(1);
  await overlayWindow.waitForTimeout(1000);
  await expect(marker).toHaveCount(0);
  await controlPanel.evaluate(() =>
    window.electronAPI.narratorUpdateSettings({ answerByVoice: true })
  );
  await expect(marker).toBeVisible({ timeout: 10_000 });
  await expect(marker).toHaveAttribute("data-count", "1");
  // Answered at the PC: the count goes.
  writeAnswer();
  await expect(marker).toHaveCount(0, { timeout: 10_000 });
});

test("speaks the Danish test line after Read Aloud's splitter has run", async ({
  electronApp,
  controlPanel,
}) => {
  test.skip(!HAS_VOICE, "the Danish voice is not downloaded on this machine");
  // The splitter imports kokoro-js in the main process, which loads ONNX
  // Runtime 1.21 there. The Danish voice once ran sherpa-onnx in the same
  // process, asked that runtime for API 28, and the whole app exited.
  const sentences = await controlPanel.evaluate(() =>
    window.electronAPI.readAloudSplit("Første sætning. Anden sætning.")
  );
  expect(sentences.length).toBeGreaterThan(0);

  await controlPanel.evaluate(() => window.electronAPI.narratorTestVoice("da"));
  await expect
    .poll(async () => (await narratorState(controlPanel)).lastPlayback?.result, {
      timeout: 20_000,
    })
    .toBe("done");
  expect((await narratorState(controlPanel)).voiceError).toBeNull();
  // The voice runs in its own utility process, never in the main one.
  const mainLibraries = await electronApp.evaluate(() => {
    const report = process.report?.getReport() as { sharedObjects?: string[] } | undefined;
    return (report?.sharedObjects ?? []).filter((file) => /sherpa-onnx|onnxruntime/i.test(file));
  });
  expect(mainLibraries.some((file) => /onnxruntime-node/i.test(file))).toBe(true);
  expect(mainLibraries.filter((file) => /sherpa-onnx/i.test(file))).toEqual([]);
});

test.describe("without the Danish voice", () => {
  const EMPTY_VOICE_DIR = path.join(os.tmpdir(), `pt-e2e-narrator-no-voice-${RUN}`);
  test.use({ appEnv: { ...NARRATOR_ENV, PT_NARRATOR_PIPER_DIR: EMPTY_VOICE_DIR } });
  test.beforeAll(() => fs.mkdirSync(EMPTY_VOICE_DIR, { recursive: true }));
  test.afterAll(() => fs.rmSync(EMPTY_VOICE_DIR, { recursive: true, force: true }));

  test("offers the download, and says a wait only chimes until then", async ({ controlPanel }) => {
    await controlPanel.getByRole("button", { name: "Narrator", exact: true }).click();
    await expect(controlPanel.getByRole("button", { name: "Download" })).toBeVisible();
    await expect(controlPanel.getByText("Download once (97 MB)")).toBeVisible();
    await controlPanel.getByRole("button", { name: "Narrate my Claude Code chats" }).click();
    await expect(controlPanel.getByTestId("narrator-status")).toHaveText(
      "Following your chats. A wait only chimes until the voice for this language is downloaded."
    );
    await capture(controlPanel, "voice-missing");
  });
});
