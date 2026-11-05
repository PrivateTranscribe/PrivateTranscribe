import { execFileSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures/electron-app";
import KokoroManager from "../../src/helpers/kokoro";
import type { NarratorVoiceQuestion } from "../../src/utils/narratorTypes";

/**
 * ask_by_voice end to end, LIVE ONLY: real throwaway Claude Code sessions call
 * the tool through the bridge the app copies to its data folder, a real key
 * press (SendInput through windows-hold-key.exe) answers, and the session gets
 * the answer and carries on in the same turn. Run it with
 *
 *   npx playwright test --config playwright-live.config.ts tests/e2e/narrator-ask-by-voice.live.ts
 *
 * It spends a few cheap Claude prompts (haiku), holds F20 on this PC, and opens
 * a small focus-probe window that takes the keyboard focus while keys are
 * pressed. Run it with the PC to itself. The app's sound is muted.
 *
 * What it proves, one app launch:
 *   picked      hold F20, say a choice: {"answer": "Export bug"}
 *   cancelled   a second press in the 3 s read-back: reason "cancelled"
 *   no_match    an answer that is no choice, twice heard: reason "no_match"
 *   no_answer   no press: reason "no_answer", inside 40 s
 *   /clear      narrator mode stays with the conversation it was turned on in:
 *               not_active right after /clear, answered once turned on again
 *   not_active  a chat without narrator mode, gaming mode off, Answer by voice
 *               off, the app quit (no address file) and the app crashed (an
 *               address file left by a dead process): each at once
 * and that nothing reached the focused window, and the clipboard is unchanged.
 *
 * The microphone is Chromium's fake capture device playing "The export bug."
 * in the local Kokoro voice, made at the start, so no audio is committed.
 *
 * Throwaway sessions write their transcripts to ~/.claude/projects as every
 * Claude Code session does. The app reads them through a junction in a temp
 * folder, so it never sees the user's real chats; the junctions are removed
 * at the end.
 */

const KEY = "F20";
/** A pick between the chat's own options, the only kind of question the tool is for. */
const QUESTION = {
  question: "Which bug should I fix first?",
  choices: ["Export bug", "Upload bug"],
  chat: "Bug sweep",
};
/** What the microphone says. Whisper base hears it whole, as the app runs it. */
const SPOKEN = "The export bug.";
const UNMATCHED = { ...QUESTION, choices: ["Settings page", "History page"] };

const REPO = path.resolve(__dirname, "..", "..");
const HOLD_KEY_EXE = path.join(REPO, "resources", "bin", "windows-hold-key.exe");
const FOCUS_PROBE = path.join(__dirname, "fixtures", "focus-probe.ps1");
const EVIDENCE = path.resolve("test-results/narrator-ask");
const CLAUDE_PROJECTS = path.join(os.homedir(), ".claude", "projects");

// Only paths here: Playwright loads this file in its runner process too, and
// the folders are made once, in the worker that runs the test.
const WORK = path.join(os.tmpdir(), `pt-ask-live-${process.pid}-${Date.now().toString(36)}`);
const ROOT = path.join(WORK, "projects");
const SESSIONS = path.join(WORK, "sessions");
const CHAT_DIR = path.join(WORK, "chat");
const PLAIN_DIR = path.join(WORK, "plain");
const ANSWER_WAV = path.join(WORK, "answer.wav");

/**
 * The answer in the local Kokoro voice, at Kokoro's own rate, the way the
 * repo's dictation fixtures are made. The fake device starts the file when a
 * recording opens and loops it, so the silence after the words outlasts the
 * longest recording (6 s): every hold hears the answer exactly once.
 */
async function makeAnswerWav(file: string) {
  const kokoro = new KokoroManager();
  const status = await kokoro.checkModelStatus();
  if (!status.installed) throw new Error(`Kokoro model not installed at ${status.dir}`);
  await kokoro.loadEngine();
  const spoken = await kokoro.synthesize(SPOKEN, { voice: "af_heart", speed: 1.0 });
  kokoro.unloadEngine();
  const rate: number = spoken.sampleRate;
  const lead = Math.round(rate * 0.4);
  const samples = new Float32Array(lead + spoken.pcm.length + rate * 7);
  samples.set(spoken.pcm, lead);
  const pcm = Buffer.alloc(samples.length * 2);
  samples.forEach((value, i) => {
    pcm.writeInt16LE(Math.round(Math.max(-1, Math.min(1, value)) * 32767), i * 2);
  });
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  fs.writeFileSync(file, Buffer.concat([header, pcm]));
}

test.beforeAll(async () => {
  test.setTimeout(120_000);
  for (const dir of [ROOT, SESSIONS, CHAT_DIR, PLAIN_DIR]) fs.mkdirSync(dir, { recursive: true });
  // A project skill named "narrator": loading it turns narrator mode on for the chat.
  fs.mkdirSync(path.join(CHAT_DIR, ".claude", "skills", "narrator"), { recursive: true });
  fs.writeFileSync(
    path.join(CHAT_DIR, ".claude", "skills", "narrator", "SKILL.md"),
    [
      "---",
      "name: narrator",
      "description: Turns narrator mode on for this chat. Run it when asked to.",
      "---",
      "",
      "Narrator mode is on for this chat. Carry on with the task.",
      "",
    ].join("\n")
  );
  await makeAnswerWav(ANSWER_WAV);
});

test.use({
  experimentalFeatures: true,
  seedKokoroModel: true,
  seedRealWhisperModels: ["base"],
  fakeAudioCaptureFile: ANSWER_WAV,
  appArgs: ["--mute-audio"],
  appEnv: {
    PT_NARRATOR_CLAUDE_DIR: ROOT,
    PT_NARRATOR_DESKTOP_SESSIONS_DIR: SESSIONS,
    PT_NARRATOR_REWRITER: "stub",
    WHISPER_FORCE_CPU: "true",
    // The dictation key is held for real, so the key listener runs. Global
    // shortcuts stay off: the listener only watches, it takes no key.
    PRIVATETRANSCRIBE_DIAG_DISABLE_WINDOWS_KEY_LISTENER: "",
  },
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Claude Code's folder name for a working directory. */
const projectFolder = (cwd: string) => cwd.replace(/[^a-zA-Z0-9]/g, "-");

const links: string[] = [];

/**
 * Lets the app read one throwaway chat: a junction in its temp root to the
 * chat's real project folder, made the moment the transcript appears.
 */
async function linkChat(cwd: string, sessionId: string) {
  const folder = projectFolder(cwd);
  const target = path.join(CLAUDE_PROJECTS, folder);
  const link = path.join(ROOT, folder);
  const deadline = Date.now() + 30_000;
  while (!fs.existsSync(path.join(target, `${sessionId}.jsonl`))) {
    if (Date.now() > deadline) throw new Error(`no transcript for ${sessionId}`);
    await sleep(100);
  }
  if (!fs.existsSync(link)) {
    fs.symlinkSync(target, link, "junction");
    links.push(link);
  }
}

type AskRun = {
  sessionId: string;
  toolInput: unknown;
  toolText: string | null;
  toolMs: number | null;
  result: string;
  isError: boolean;
};

/** What a throwaway chat is told: optionally load the narrator skill, then ask once. */
function askPrompt(ask: typeof QUESTION, loadSkill: boolean): string {
  return [
    loadSkill ? "First run the narrator skill with the Skill tool." : "",
    `Then call the ask_by_voice tool exactly once with this input: ${JSON.stringify(ask)}.`,
    "Call no other tool.",
    "When it returns, reply with exactly one line: RESULT followed by the tool's JSON output, unchanged.",
  ]
    .filter(Boolean)
    .join(" ");
}

/** The environment of a throwaway chat: not a side session of the one running this spec. */
function chatEnv() {
  const vars = { ...process.env };
  for (const name of [
    "CLAUDE_CODE_SESSION_ID",
    "CLAUDE_CODE_HOST_SESSION_ID",
    "CLAUDE_CODE_MESSAGING_SOCKET",
    "CLAUDE_CODE_MESSAGING_TOKEN",
  ]) {
    delete vars[name];
  }
  return vars;
}

/** Haiku, only this app's MCP server, and none of the user's settings, hooks or MCP servers. */
const chatArgs = (sessionId: string, mcpConfig: string) => [
  "--model",
  "haiku",
  "--session-id",
  sessionId,
  "--mcp-config",
  mcpConfig,
  "--strict-mcp-config",
  "--setting-sources",
  "project",
  "--allowedTools",
  "Skill",
  "mcp__privatetranscribe__ask_by_voice",
  "--output-format",
  "stream-json",
  "--verbose",
];

/**
 * Reads a throwaway chat's stream-json events into one run: the ask_by_voice
 * call, its result and how long it took, and the reply.
 */
function trackRun(run: AskRun) {
  let toolId: string | null = null;
  let calledAt = 0;
  return (event: any) => {
    for (const block of event.message?.content || []) {
      if (block.type === "tool_use" && String(block.name).endsWith("__ask_by_voice")) {
        toolId = block.id;
        calledAt = Date.now();
        run.toolInput = block.input;
      }
      if (block.type === "tool_result" && block.tool_use_id === toolId) {
        run.toolMs = Date.now() - calledAt;
        run.toolText = Array.isArray(block.content)
          ? block.content.map((part: any) => part.text || "").join("")
          : String(block.content);
      }
    }
    if (event.type === "result") {
      run.result = String(event.result || "");
      run.isError = Boolean(event.is_error);
    }
  };
}

/** Calls `onEvent` for each JSON line a chat writes. */
function readEvents(child: ReturnType<typeof spawn>, onEvent: (event: any) => void) {
  let buffer = "";
  child.stdout!.on("data", (chunk) => {
    buffer += chunk;
    let at;
    while ((at = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, at).trim();
      buffer = buffer.slice(at + 1);
      if (!line) continue;
      try {
        onEvent(JSON.parse(line));
      } catch {
        // Not an event.
      }
    }
  });
}

const newRun = (sessionId: string): AskRun => ({
  sessionId,
  toolInput: null,
  toolText: null,
  toolMs: null,
  result: "",
  isError: false,
});

/** One throwaway Claude Code session, in -p mode: one prompt, one turn. */
function askClaude({
  cwd,
  mcpConfig,
  ask,
  loadSkill,
}: {
  cwd: string;
  mcpConfig: string;
  ask: typeof QUESTION;
  loadSkill: boolean;
}): { sessionId: string; done: Promise<AskRun> } {
  const sessionId = crypto.randomUUID();
  const child = spawn("claude", ["-p", askPrompt(ask, loadSkill), ...chatArgs(sessionId, mcpConfig)], {
    cwd,
    env: chatEnv(),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const run = newRun(sessionId);
  readEvents(child, trackRun(run));
  const done = new Promise<AskRun>((resolve, reject) => {
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (!run.result && code !== 0)
        reject(new Error(`claude exited ${code}: ${stderr.slice(0, 400)}`));
      else resolve(run);
    });
  });
  return { sessionId, done };
}

/**
 * One throwaway Claude Code session kept open over stream-json, the way the
 * desktop app drives one, so it can /clear between turns. Each `say` is one
 * turn; its run carries the session id the chat is on when the turn ends.
 */
function openChat({ cwd, mcpConfig }: { cwd: string; mcpConfig: string }) {
  const firstSessionId = crypto.randomUUID();
  const child = spawn(
    "claude",
    ["-p", "--input-format", "stream-json", ...chatArgs(firstSessionId, mcpConfig)],
    { cwd, env: chatEnv(), stdio: ["pipe", "pipe", "pipe"], windowsHide: true }
  );
  let sessionId = firstSessionId;
  let turn: { run: AskRun; track: (event: any) => void; resolve: (run: AskRun) => void } | null =
    null;
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk));
  readEvents(child, (event) => {
    // /clear starts a new conversation, announced with a new init and its id.
    if (event.type === "system" && event.subtype === "init" && event.session_id) {
      sessionId = event.session_id;
    }
    if (!turn) return;
    turn.track(event);
    if (event.type === "result") {
      const done = turn;
      turn = null;
      done.run.sessionId = sessionId;
      done.resolve(done.run);
    }
  });
  const closed = new Promise<void>((resolve) =>
    child.on("close", () => {
      // A chat that ends mid-turn ends that turn, with what it said on the way out.
      if (turn) {
        const done = turn;
        turn = null;
        Object.assign(done.run, { result: `exited: ${stderr.slice(0, 400)}`, isError: true });
        done.resolve(done.run);
      }
      resolve();
    })
  );
  return {
    firstSessionId,
    say(text: string): Promise<AskRun> {
      return new Promise((resolve) => {
        const run = newRun(sessionId);
        turn = { run, track: trackRun(run), resolve };
        child.stdin!.write(
          `${JSON.stringify({
            type: "user",
            session_id: "",
            parent_tool_use_id: null,
            message: { role: "user", content: [{ type: "text", text }] },
          })}\n`
        );
      });
    },
    async close() {
      child.stdin!.end();
      await closed;
    },
  };
}

/** Holds the dictation key for real (SendInput) for `ms`, then lets go. */
function holdKey(ms: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(HOLD_KEY_EXE, [`--key=${KEY}`, `--max-ms=${ms}`], {
      stdio: ["pipe", "ignore", "ignore"],
      windowsHide: true,
    });
    child.on("error", reject);
    child.on("close", () => resolve());
  });
}

/** Whether a key listener process watches this key (its only argument). */
function listenerWatches(key: string): boolean {
  const out = execFileSync(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      "Get-CimInstance Win32_Process -Filter \"name='windows-key-listener.exe'\" | " +
        "ForEach-Object { ($_.CommandLine -split ' ')[-1] }",
    ],
    { encoding: "utf8" }
  );
  return out.split(/\r?\n/).some((line) => line.trim() === key);
}

/** SHA-256 of the clipboard's text, so it is compared without ever being printed. */
function clipboardHash(): string {
  return execFileSync(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      "$t = [string](Get-Clipboard -Raw); $b = [Text.Encoding]::UTF8.GetBytes($t); " +
        "[BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($b))",
    ],
    { encoding: "utf8" }
  ).trim();
}

/** The focus probe window: takes the keyboard focus until stopped. */
function startFocusProbe() {
  const result = path.join(WORK, `probe-${Date.now()}.json`);
  const doneFile = `${result}.done`;
  const child = spawn(
    "powershell",
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      FOCUS_PROBE,
      "-ResultFile",
      result,
      "-DoneFile",
      doneFile,
    ],
    { stdio: "ignore" }
  );
  return {
    async stop(): Promise<{ active: number; checks: number; text: string }> {
      fs.writeFileSync(doneFile, "done");
      const deadline = Date.now() + 10_000;
      while (!fs.existsSync(result) && Date.now() < deadline) await sleep(100);
      child.kill();
      return JSON.parse(fs.readFileSync(result, "utf8").replace(/^﻿/, ""));
    },
  };
}

/**
 * A busy, saturated scene behind the overlay for the screenshots, standing in
 * for a game: sky, terrain, bright particles and HUD text. Test-only paint.
 */
async function paintBusyBackground(overlay: Page) {
  await overlay.evaluate(() => {
    if (document.getElementById("pt-busy")) return;
    const canvas = document.createElement("canvas");
    canvas.id = "pt-busy";
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    Object.assign(canvas.style, {
      position: "fixed",
      inset: "0",
      width: "100%",
      height: "100%",
      zIndex: "-1",
      pointerEvents: "none",
    });
    const g = canvas.getContext("2d")!;
    let seed = 7;
    const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const sky = g.createLinearGradient(0, 0, 0, canvas.height);
    sky.addColorStop(0, "#1c3f78");
    sky.addColorStop(0.45, "#c0632e");
    sky.addColorStop(1, "#f2c14e");
    g.fillStyle = sky;
    g.fillRect(0, 0, canvas.width, canvas.height);
    for (let layer = 0; layer < 3; layer++) {
      g.fillStyle = ["#2d4a2b", "#1e3320", "#0f1d12"][layer];
      g.beginPath();
      g.moveTo(0, canvas.height);
      for (let x = 0; x <= canvas.width; x += 20) {
        g.lineTo(x, canvas.height * (0.45 + layer * 0.12) - rand() * 70);
      }
      g.lineTo(canvas.width, canvas.height);
      g.fill();
    }
    for (let i = 0; i < 160; i++) {
      g.fillStyle = ["#ffffff", "#ffe066", "#7ef0ff", "#ff5d73"][i % 4];
      g.globalAlpha = 0.5 + rand() * 0.5;
      g.beginPath();
      g.arc(rand() * canvas.width, rand() * canvas.height, 1 + rand() * 4, 0, Math.PI * 2);
      g.fill();
    }
    g.globalAlpha = 1;
    g.font = "bold 13px sans-serif";
    const hud = ["HP 1240 / 1600", "Quest updated", "Raid: 23 / 25", "Gold 4 812", "Mana 63%"];
    hud.forEach((line, i) => {
      g.fillStyle = i % 2 ? "#ffffff" : "#ffe066";
      g.fillText(line, 12 + (i % 2) * 210, 28 + i * 64);
    });
    g.fillStyle = "#c92a2a";
    g.fillRect(12, canvas.height - 40, 150, 10);
    g.fillStyle = "#1971c2";
    g.fillRect(12, canvas.height - 24, 110, 10);
    document.body.prepend(canvas);
  });
}

async function shot(overlay: Page, name: string) {
  fs.mkdirSync(EVIDENCE, { recursive: true });
  await overlay.screenshot({ path: path.join(EVIDENCE, `${name}.png`) });
}

/** How long the key is held for an answer: the time a microphone takes to open, the 0.4 s lead and the words. */
const ANSWER_HOLD_MS = 4500;

test("ask_by_voice end to end, with a real key press", async ({
  electronApp,
  controlPanel,
  overlayWindow,
  userDataDir,
}) => {
  test.setTimeout(15 * 60_000);
  // What the overlay heard for each answer, read beside the app's own handler.
  // The text is this spec's synthetic answer, so it may be kept.
  await electronApp.evaluate(({ ipcMain }) => {
    const store = globalThis as unknown as { __heard: unknown[] };
    store.__heard = [];
    ipcMain.on("narrator-answer-heard", (_event, payload) => store.__heard.push(payload));
  });
  const heard = () =>
    electronApp.evaluate(() => (globalThis as unknown as { __heard: unknown[] }).__heard);
  const state = () => controlPanel.evaluate(() => window.electronAPI.narratorGetState());
  const question = async () => (await state()).question as NarratorVoiceQuestion | null;
  /** Waits for the question of this ask to reach a phase; returns it. */
  const waitPhase = async (
    phases: string[],
    { after = "", timeout = 45_000 }: { after?: string; timeout?: number } = {}
  ) => {
    const deadline = Date.now() + timeout;
    for (;;) {
      const now = await question();
      if (now && now.id !== after && phases.includes(now.phase)) return now;
      if (Date.now() > deadline) {
        throw new Error(
          `question never reached ${phases.join("/")}: ${JSON.stringify(now)}; ` +
            `heard ${JSON.stringify(await heard())}`
        );
      }
      await sleep(80);
    }
  };

  // Local Whisper, the dictation key on F20 in hold mode, no paste extras.
  await overlayWindow.evaluate((key) => {
    localStorage.setItem("useLocalWhisper", "true");
    localStorage.setItem("allowOpenAIFallback", "false");
    localStorage.setItem("whisperModel", "base");
    localStorage.setItem("localTranscriptionProvider", "whisper");
    localStorage.setItem("useReasoningModel", "false");
    localStorage.setItem("whisperForceCpu", "true");
    localStorage.setItem("preferredLanguage", "en");
    localStorage.setItem("audioFeedback", "false");
    localStorage.setItem("dictationKey", key);
    localStorage.setItem("activationMode", "tapHold");
  }, KEY);
  await overlayWindow.reload({ waitUntil: "domcontentloaded" });
  await expect(overlayWindow.getByRole("button", { name: "Dictation overlay" })).toBeVisible();
  await overlayWindow.evaluate(async (key) => {
    const api = (window as unknown as { electronAPI: any }).electronAPI;
    await api.updateHotkey(key);
    api.notifyActivationModeChanged("tapHold");
  }, KEY);
  await paintBusyBackground(overlayWindow);

  await controlPanel.evaluate(() => window.electronAPI.narratorSetGate(true));
  await controlPanel.evaluate(() =>
    window.electronAPI.narratorUpdateSettings({
      enabled: true,
      gaming: true,
      answerByVoice: true,
      makeRoom: false,
      language: "en",
      onlyNarratorMode: true,
    })
  );
  await expect
    .poll(async () => (await state()).takesVoiceQuestions, { timeout: 30_000 })
    .toBe(true);
  await expect.poll(() => listenerWatches(KEY), { timeout: 15_000 }).toBe(true);
  // A first sentence loads the voice, so the first question is not late.
  await Promise.race([
    controlPanel.evaluate(() => window.electronAPI.narratorTestVoice("en")),
    sleep(30_000),
  ]);
  const addressFile = path.join(userDataDir, "narrator-ask.json");
  const bridge = path.join(userDataDir, "ask-by-voice-mcp.cjs");
  await expect.poll(() => fs.existsSync(addressFile) && fs.existsSync(bridge)).toBe(true);

  // The Narrator page with Answer by voice on: the Connect Claude Code row.
  await controlPanel.getByRole("button", { name: "Narrator", exact: true }).click();
  await controlPanel.setViewportSize({ width: 1232, height: 1180 });
  const connect = controlPanel.getByTestId("narrator-connect");
  await expect(connect).toBeVisible();
  await expect(controlPanel.getByTestId("narrator-connect-command")).toContainText(
    "claude mcp add --scope user privatetranscribe -- node"
  );
  await connect.scrollIntoViewIfNeeded();
  fs.mkdirSync(EVIDENCE, { recursive: true });
  await controlPanel.screenshot({ path: path.join(EVIDENCE, "page-hands-free.png") });

  // Claude Code reaches the app the way the page's command sets it up: node
  // running the bridge from the app's data folder, which finds the app there.
  const mcpConfig = path.join(WORK, "mcp.json");
  fs.writeFileSync(
    mcpConfig,
    JSON.stringify({
      mcpServers: { privatetranscribe: { type: "stdio", command: "node", args: [bridge] } },
    })
  );

  const clipboardBefore = clipboardHash();
  const probe = startFocusProbe();
  await sleep(1500);
  const results: Record<string, AskRun> = {};
  let focus = { active: 0, checks: 0, text: "" };

  try {
    // 1. picked: hold the key, say "The export bug", let the read-back send it.
    {
      const run = askClaude({ cwd: CHAT_DIR, mcpConfig, ask: QUESTION, loadSkill: true });
      await linkChat(CHAT_DIR, run.sessionId);
      const speaking = await waitPhase(["speaking"]);
      await sleep(400);
      await shot(overlayWindow, "1-speaking");
      await waitPhase(["open"]);
      await sleep(1200);
      await shot(overlayWindow, "2-open");
      const held = holdKey(ANSWER_HOLD_MS);
      await waitPhase(["recording"]);
      await sleep(1200);
      await shot(overlayWindow, "3-listening");
      await held;
      await waitPhase(["confirming"]);
      await sleep(600);
      await shot(overlayWindow, "4-sending");
      const done = await waitPhase(["done"]);
      await sleep(150);
      await shot(overlayWindow, "5-sent");
      expect(done.id).toBe(speaking.id);
      results.picked = await run.done;
      expect(JSON.parse(results.picked.toolText || "null")).toEqual({ answer: "Export bug" });
      expect(results.picked.result).toContain('RESULT {"answer":"Export bug"}');
    }

    // 2. cancelled: a second press while the pick is read back.
    {
      const before = (await question())?.id || "";
      const run = askClaude({ cwd: CHAT_DIR, mcpConfig, ask: QUESTION, loadSkill: true });
      await linkChat(CHAT_DIR, run.sessionId);
      await waitPhase(["open"], { after: before });
      await holdKey(ANSWER_HOLD_MS);
      await waitPhase(["confirming"], { after: before });
      await sleep(300);
      await holdKey(150);
      await waitPhase(["done"], { after: before });
      await sleep(150);
      await shot(overlayWindow, "6-cancelled");
      results.cancelled = await run.done;
      expect(JSON.parse(results.cancelled.toolText || "null")).toEqual({
        answer: null,
        reason: "cancelled",
      });
    }

    // 3. no_match: "The export bug" is not one of these choices.
    {
      const before = (await question())?.id || "";
      const run = askClaude({ cwd: CHAT_DIR, mcpConfig, ask: UNMATCHED, loadSkill: true });
      await linkChat(CHAT_DIR, run.sessionId);
      await waitPhase(["open"], { after: before });
      await holdKey(ANSWER_HOLD_MS);
      await waitPhase(["not-caught"], { after: before });
      await sleep(300);
      await shot(overlayWindow, "7-not-caught");
      const again = await waitPhase(["open"], { after: before });
      expect(again.missed).toBeGreaterThan(0);
      await sleep(600);
      await shot(overlayWindow, "8-try-again");
      await waitPhase(["done"], { after: before, timeout: 60_000 });
      await sleep(150);
      await shot(overlayWindow, "9-no-match");
      results.noMatch = await run.done;
      expect(JSON.parse(results.noMatch.toolText || "null")).toEqual({
        answer: null,
        reason: "no_match",
      });
      // The unanswered chat stays as a quiet count once the card has faded.
      await expect
        .poll(async () => (await state()).waiting, { timeout: 15_000 })
        .toBeGreaterThan(0);
      await expect(overlayWindow.getByTestId("narrator-waiting")).toBeVisible({ timeout: 15_000 });
      await shot(overlayWindow, "10-waiting");
    }

    // 4. no_answer: nobody presses the key.
    {
      const before = (await question())?.id || "";
      const run = askClaude({ cwd: CHAT_DIR, mcpConfig, ask: QUESTION, loadSkill: true });
      await linkChat(CHAT_DIR, run.sessionId);
      await waitPhase(["done"], { after: before, timeout: 60_000 });
      await sleep(150);
      await shot(overlayWindow, "11-no-answer");
      results.noAnswer = await run.done;
      expect(JSON.parse(results.noAnswer.toolText || "null")).toEqual({
        answer: null,
        reason: "no_answer",
      });
      expect(results.noAnswer.toolMs).toBeLessThan(41_000);
    }

    // 5. /clear: narrator mode belongs to a conversation. /clear moves the chat
    //    to a new one while Claude Code keeps the same tool server running, so
    //    a question right after it finds narrator mode off. Turned on again,
    //    the question is said and answered.
    {
      const before = (await question())?.id || "";
      const chat = openChat({ cwd: CHAT_DIR, mcpConfig });
      try {
        const on = await chat.say("Run the narrator skill with the Skill tool. Then reply with OK.");
        expect(on.isError).toBe(false);
        const cleared = await chat.say("/clear");
        expect(cleared.sessionId).not.toBe(chat.firstSessionId);
        results.afterClear = await chat.say(askPrompt(QUESTION, false));
        expect(JSON.parse(results.afterClear.toolText || "null")).toEqual({
          answer: null,
          reason: "not_active",
        });
        expect(results.afterClear.toolMs).toBeLessThan(5_000);
        expect((await question())?.id || "").toBe(before);

        const asking = chat.say(askPrompt(QUESTION, true));
        await waitPhase(["open"], { after: before });
        await holdKey(ANSWER_HOLD_MS);
        await waitPhase(["done"], { after: before });
        results.clearedThenOn = await asking;
        expect(results.clearedThenOn.sessionId).toBe(cleared.sessionId);
        expect(JSON.parse(results.clearedThenOn.toolText || "null")).toEqual({
          answer: "Export bug",
        });
      } finally {
        await chat.close();
      }
    }
  } finally {
    focus = await probe.stop();
    fs.writeFileSync(
      path.join(EVIDENCE, "focus.json"),
      JSON.stringify({ active: focus.active, checks: focus.checks, textLength: focus.text.length })
    );
  }
  // Nothing the answers did reached the focused window or the clipboard. The
  // window check holds only while the probe kept the focus throughout: Windows
  // keeps a new window in the background if the PC was used in the last 200 s,
  // and the overlay taking the focus would show here as well.
  expect(focus.text).toBe("");
  expect(clipboardHash()).toBe(clipboardBefore);
  expect(
    focus.active / Math.max(1, focus.checks),
    "share of checks the probe held the focus"
  ).toBeGreaterThan(0.95);

  // 5. not_active: a chat that never turned narrator mode on.
  {
    const run = askClaude({ cwd: PLAIN_DIR, mcpConfig, ask: QUESTION, loadSkill: false });
    await linkChat(PLAIN_DIR, run.sessionId);
    results.notNarrator = await run.done;
    expect(JSON.parse(results.notNarrator.toolText || "null")).toEqual({
      answer: null,
      reason: "not_active",
    });
    expect(results.notNarrator.toolMs).toBeLessThan(5_000);
  }

  // 6. not_active: gaming mode off, the app still running.
  {
    await controlPanel.evaluate(() => window.electronAPI.narratorUpdateSettings({ gaming: false }));
    const run = askClaude({ cwd: CHAT_DIR, mcpConfig, ask: QUESTION, loadSkill: true });
    results.gamingOff = await run.done;
    expect(JSON.parse(results.gamingOff.toolText || "null")).toEqual({
      answer: null,
      reason: "not_active",
    });
    expect(results.gamingOff.toolMs).toBeLessThan(5_000);
  }

  // 7. not_active: Answer by voice off, so the app stops listening for the bridge.
  {
    await controlPanel.evaluate(() =>
      window.electronAPI.narratorUpdateSettings({ gaming: true, answerByVoice: false })
    );
    await expect.poll(() => fs.existsSync(addressFile)).toBe(false);
    const run = askClaude({ cwd: CHAT_DIR, mcpConfig, ask: QUESTION, loadSkill: true });
    results.answerOff = await run.done;
    expect(JSON.parse(results.answerOff.toolText || "null")).toEqual({
      answer: null,
      reason: "not_active",
    });
    expect(results.answerOff.toolMs).toBeLessThan(5_000);
  }

  // 8. The app not running: quit (no address file) and crashed (one left by a dead process).
  {
    const quitDir = path.join(WORK, "app-quit");
    const crashDir = path.join(WORK, "app-crashed");
    for (const dir of [quitDir, crashDir]) {
      fs.mkdirSync(dir, { recursive: true });
      fs.copyFileSync(bridge, path.join(dir, "ask-by-voice-mcp.cjs"));
    }
    const dead = spawn(process.execPath, ["-e", "0"]);
    await new Promise((resolve) => dead.on("close", resolve));
    fs.writeFileSync(
      path.join(crashDir, "narrator-ask.json"),
      JSON.stringify({ port: 9, token: "0".repeat(64), pid: dead.pid })
    );
    for (const [name, dir] of [
      ["appQuit", quitDir],
      ["appCrashed", crashDir],
    ] as const) {
      const config = path.join(dir, "mcp.json");
      fs.writeFileSync(
        config,
        JSON.stringify({
          mcpServers: {
            privatetranscribe: {
              type: "stdio",
              command: "node",
              args: [path.join(dir, "ask-by-voice-mcp.cjs")],
            },
          },
        })
      );
      const run = askClaude({ cwd: CHAT_DIR, mcpConfig: config, ask: QUESTION, loadSkill: true });
      results[name] = await run.done;
      expect(JSON.parse(results[name].toolText || "null")).toEqual({
        answer: null,
        reason: "not_active",
      });
      expect(results[name].toolMs).toBeLessThan(5_000);
    }
  }

  fs.writeFileSync(
    path.join(EVIDENCE, "runs.json"),
    JSON.stringify(
      Object.fromEntries(
        Object.entries(results).map(([name, run]) => [
          name,
          { tool: run.toolText, toolMs: run.toolMs, reply: run.result },
        ])
      ),
      null,
      2
    )
  );
});

test.afterAll(() => {
  // Junctions first, one by one: a recursive delete must never walk into ~/.claude.
  for (const link of links) {
    try {
      fs.rmdirSync(link);
    } catch {
      // Already gone.
    }
  }
  if (!fs.existsSync(WORK)) return;
  const leftover = fs.existsSync(ROOT)
    ? fs.readdirSync(ROOT).filter((name) => fs.lstatSync(path.join(ROOT, name)).isSymbolicLink())
    : [];
  if (leftover.length === 0) fs.rmSync(WORK, { recursive: true, force: true });
});
