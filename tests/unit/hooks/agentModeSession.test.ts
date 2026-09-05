/**
 * Tests for the Agent Mode session flag in `useAudioRecording.js`.
 *
 * The hook itself needs a DOM and the whole Electron preload surface, and this
 * repo's Vitest environment is `node` with no jsdom or testing-library
 * installed, so rendering it is not feasible. Following the pattern in
 * `actionEnginePipeline.test.ts`, the two decision blocks are reimplemented
 * here as plain functions:
 *
 *  - `handleAgentStart` (the guards, the Starter cap, the Agent Mode cap)
 *  - the agent branch of `onTranscriptionComplete` (starter counting, the rules
 *    pass, use recording, the skipped Action Engine, the paste options)
 *
 * The collaborating modules are the real ones: `cleanAgentPrompt`,
 * `agentModeUsage` and `starterUsage` are imported, not faked, so the contracts
 * between them are exercised for real. If the inline logic in
 * useAudioRecording.js changes, update this test to match.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { cleanAgentPrompt } from "../../../src/utils/agentPrompt.js";
import {
  isAgentModeLimitReached,
  readAgentModeUsage,
  recordAgentModeUse,
  buildAgentModeLimitMessage,
  writeAgentModeUsage,
  AGENT_MODE_DAILY_USE_LIMIT,
} from "../../../src/utils/agentModeUsage.js";
import { readStarterUsage, recordStarterWords } from "../../../src/utils/starterUsage.js";

function createStorage(): Storage {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
    clear: () => store.clear(),
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    get length() {
      return store.size;
    },
  } as Storage;
}

interface Toast {
  title?: string;
  description?: string;
  duration?: number;
}

function createSession({ pro = false, storage = createStorage() } = {}) {
  const toasts: Toast[] = [];
  const openedPanels: unknown[] = [];
  const pastes: Array<{ text: string; options: Record<string, unknown> }> = [];

  const actionEngineMatch = vi.fn(async () => ({ success: true, matches: [] }));
  const cleanAgentPromptSpy = vi.fn(cleanAgentPrompt);
  const recordAgentModeUseSpy = vi.fn(() => recordAgentModeUse(storage));
  const recordStarterWordsSpy = vi.fn((text: string) => recordStarterWords(text, storage));

  const state = { isRecording: false, isProcessing: false, isStartingRecording: false };
  let agentSession = false;

  const isProEntitled = () => pro;

  // ── handleAgentStart ──────────────────────────────────────────────────────
  const beginRecordingFlow = vi.fn(async () => {
    if (state.isRecording || state.isProcessing || state.isStartingRecording) return false;
    state.isRecording = true;
    return true;
  });

  const agentModeCanBegin = () => {
    if (isProEntitled()) return true;
    if (!isAgentModeLimitReached(storage)) return true;
    const usage = readAgentModeUsage(storage);
    toasts.push({
      title: "Agent Mode free uses spent for today",
      description: buildAgentModeLimitMessage(usage),
      duration: 8000,
    });
    openedPanels.push({ page: "settings", settingsTab: "pro" });
    return false;
  };

  const handleAgentStart = async () => {
    if (state.isRecording || state.isProcessing || state.isStartingRecording) return;
    if (!agentModeCanBegin()) return;

    agentSession = true;
    const started = await beginRecordingFlow();
    if (!started) agentSession = false;
  };

  const cancel = () => {
    state.isRecording = false;
    state.isProcessing = false;
    agentSession = false;
  };

  // ── onTranscriptionComplete ───────────────────────────────────────────────
  const complete = async (rawText: string) => {
    const wasAgentSession = agentSession;
    agentSession = false;
    state.isRecording = false;
    state.isProcessing = false;

    let text = rawText;

    if (!isProEntitled()) {
      recordStarterWordsSpy(text);
    }

    let sendEnter = false;
    if (wasAgentSession) {
      const cleaned = cleanAgentPromptSpy(text);
      text = cleaned.text;
      sendEnter = cleaned.send;
      if (!isProEntitled()) {
        recordAgentModeUseSpy();
      }
    }

    if (!wasAgentSession) {
      await actionEngineMatch();
    }

    pastes.push({ text, options: sendEnter ? { sendEnter: true } : {} });
    return { text, sendEnter };
  };

  return {
    state,
    storage,
    toasts,
    openedPanels,
    pastes,
    beginRecordingFlow,
    actionEngineMatch,
    cleanAgentPromptSpy,
    recordAgentModeUseSpy,
    recordStarterWordsSpy,
    handleAgentStart,
    cancel,
    complete,
    isAgentSession: () => agentSession,
  };
}

function fillAgentModeCap(storage: Storage) {
  writeAgentModeUsage(
    { ...readAgentModeUsage(storage), usesToday: AGENT_MODE_DAILY_USE_LIMIT },
    storage
  );
}

describe("Agent Mode session", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("pastes the cleaned prompt and presses Enter on a trailing send", async () => {
    const session = createSession();

    await session.handleAgentStart();
    expect(session.beginRecordingFlow).toHaveBeenCalledTimes(1);
    expect(session.isAgentSession()).toBe(true);

    await session.complete("fix the bug send");

    expect(session.pastes).toHaveLength(1);
    expect(session.pastes[0].options).toEqual({ sendEnter: true });
    expect(session.pastes[0].text).toBe(cleanAgentPrompt("fix the bug send").text);
    expect(session.pastes[0].text.toLowerCase().endsWith("send")).toBe(false);
    expect(session.recordAgentModeUseSpy).toHaveBeenCalledTimes(1);
    expect(session.actionEngineMatch).not.toHaveBeenCalled();
    expect(session.isAgentSession()).toBe(false);
  });

  it("leaves sendEnter off without a trailing send", async () => {
    const session = createSession();

    await session.handleAgentStart();
    await session.complete("fix the bug in the parser");

    expect(session.pastes[0].options).toEqual({});
    expect(session.pastes[0].options.sendEnter).toBeUndefined();
  });

  it("never begins a recording for a free user at the Agent Mode cap", async () => {
    const storage = createStorage();
    fillAgentModeCap(storage);
    const session = createSession({ storage });

    await session.handleAgentStart();

    expect(session.beginRecordingFlow).not.toHaveBeenCalled();
    expect(session.state.isRecording).toBe(false);
    expect(session.isAgentSession()).toBe(false);
    expect(session.toasts).toHaveLength(1);
    expect(session.toasts[0].title).toBe("Agent Mode free uses spent for today");
    expect(session.openedPanels).toEqual([{ page: "settings", settingsTab: "pro" }]);
  });

  it("lets a Pro user record past the cap", async () => {
    const storage = createStorage();
    fillAgentModeCap(storage);
    const session = createSession({ pro: true, storage });

    await session.handleAgentStart();

    expect(session.beginRecordingFlow).toHaveBeenCalledTimes(1);
    expect(session.state.isRecording).toBe(true);
    expect(session.toasts).toHaveLength(0);

    await session.complete("ship it send");
    expect(session.recordAgentModeUseSpy).not.toHaveBeenCalled();
  });

  it("does not leak the flag from a cancelled agent session into the next dictation", async () => {
    const session = createSession();

    await session.handleAgentStart();
    expect(session.isAgentSession()).toBe(true);
    session.cancel();
    expect(session.isAgentSession()).toBe(false);

    await session.complete("open the file send");

    expect(session.cleanAgentPromptSpy).not.toHaveBeenCalled();
    expect(session.pastes[0].text).toBe("open the file send");
    expect(session.pastes[0].options).toEqual({});
    expect(session.actionEngineMatch).toHaveBeenCalledTimes(1);
  });

  it("counts Starter words from the dictated text, before the rules pass", async () => {
    const storage = createStorage();
    const session = createSession({ storage });
    const spoken = "please fix the flaky test in the parser send";

    await session.handleAgentStart();
    await session.complete(spoken);

    expect(session.recordStarterWordsSpy).toHaveBeenCalledWith(spoken);
    expect(readStarterUsage(storage).wordsUsed).toBe(9);
    // The rules pass shortened the text, and the cap did not follow it down.
    expect(session.pastes[0].text.split(/\s+/).length).toBeLessThan(9);
  });
});
