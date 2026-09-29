/**
 * Tests for the Agent Mode session flag in `useAudioRecording.js`.
 *
 * The hook itself needs a DOM and the whole Electron preload surface, and this
 * repo's Vitest environment is `node` with no jsdom or testing-library
 * installed, so rendering it is not feasible. Following the pattern in
 * `actionEnginePipeline.test.ts`, the two decision blocks are reimplemented
 * here as plain functions:
 *
 *  - `handleAgentStart` (the guards)
 *  - the agent branch of `onTranscriptionComplete` (the trailing-send split,
 *    the Claude Code rewrite and its fallback, the skipped Action Engine, the
 *    paste options)
 *
 * The collaborating modules are the real ones: `cleanAgentPrompt` and
 * `extractSendCommand` are imported, not faked, so the contracts between them
 * are exercised for real. Only the `agentModeRewrite` bridge is a fake,
 * because it shells out to the user's own Claude Code CLI. If the inline logic
 * in useAudioRecording.js changes, update this test to match.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { cleanAgentPrompt, extractSendCommand } from "../../../src/utils/agentPrompt.js";

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
  variant?: string;
  duration?: number;
}

type RewriteReply =
  | { ok: true; text: string; ms: number; apiMs: number }
  | { ok: false; reason: string; message: string; ms: number };

type RewriteFake = ((text: string) => Promise<RewriteReply>) | null;

function createSession({ storage = createStorage(), rewrite = null as RewriteFake } = {}) {
  const toasts: Toast[] = [];
  const pastes: Array<{ text: string; options: Record<string, unknown> }> = [];

  const actionEngineMatch = vi.fn(async () => ({ success: true, matches: [] }));
  const cleanAgentPromptSpy = vi.fn(cleanAgentPrompt);
  const agentModeRewrite = rewrite ? vi.fn(rewrite) : null;

  const state = { isRecording: false, isProcessing: false, isStartingRecording: false };
  let agentSession = false;
  let rewriting = false;
  let commitAllowed = true;

  const canCommit = () => commitAllowed;

  // ── handleAgentStart ──────────────────────────────────────────────────────
  const beginRecordingFlow = vi.fn(async () => {
    if (state.isRecording || state.isProcessing || state.isStartingRecording) return false;
    state.isRecording = true;
    return true;
  });

  const handleAgentStart = async () => {
    if (state.isRecording || state.isProcessing || state.isStartingRecording) return;

    agentSession = true;
    const started = await beginRecordingFlow();
    if (!started) agentSession = false;
  };

  const cancel = () => {
    state.isRecording = false;
    state.isProcessing = false;
    agentSession = false;
    rewriting = false;
  };

  // ── onTranscriptionComplete ───────────────────────────────────────────────
  const complete = async (rawText: string) => {
    const wasAgentSession = agentSession;
    agentSession = false;
    state.isRecording = false;
    state.isProcessing = false;

    let text = rawText;

    let sendEnter = false;
    if (wasAgentSession) {
      const { text: spoken, send } = extractSendCommand(text);
      sendEnter = send;
      const rewriteOn = storage.getItem("agentModeRewrite") !== "false";
      let rewritten: string | null = null;
      let failure: { reason?: string } | null = null;
      if (rewriteOn && agentModeRewrite) {
        rewriting = true;
        try {
          const reply = await agentModeRewrite(spoken);
          if (reply?.ok && typeof reply.text === "string" && reply.text.trim()) {
            rewritten = reply.text.trim();
          } else {
            failure = reply || { reason: "bad-output" };
          }
        } catch (error) {
          failure = { reason: "spawn-error", message: String((error as Error)?.message || error) };
        } finally {
          rewriting = false;
        }
        if (!canCommit()) return;
      }
      if (rewritten !== null) {
        text = rewritten;
      } else {
        text = cleanAgentPromptSpy(spoken).text;
        if (failure && failure.reason !== "disabled") {
          toasts.push({
            title:
              failure.reason === "not-found"
                ? "Claude Code not found. Pasted as spoken."
                : "Claude Code did not answer. Pasted as spoken.",
            variant: "default",
            duration: 5000,
          });
        }
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
    pastes,
    beginRecordingFlow,
    actionEngineMatch,
    cleanAgentPromptSpy,
    agentModeRewrite,
    handleAgentStart,
    cancel,
    complete,
    isAgentSession: () => agentSession,
    isRewriting: () => rewriting,
    denyCommit: () => {
      commitAllowed = false;
    },
  };
}

function rewriteOk(text: string): RewriteReply {
  return { ok: true, text, ms: 3650, apiMs: 3200 };
}

function rewriteFailed(reason: string): RewriteReply {
  return { ok: false, reason, message: `rewrite ${reason}`, ms: 12 };
}

describe("Agent Mode session", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("pastes the Claude Code rewrite and takes Enter from the spoken tail", async () => {
    const session = createSession({
      rewrite: async () => rewriteOk("Fix the crash in the parser and add a regression test."),
    });

    await session.handleAgentStart();
    expect(session.beginRecordingFlow).toHaveBeenCalledTimes(1);
    expect(session.isAgentSession()).toBe(true);

    await session.complete("uh fix the bug in the parser and add a test, send");

    // The model never sees the send word, and never decides it either.
    expect(session.agentModeRewrite).toHaveBeenCalledWith(
      "uh fix the bug in the parser and add a test"
    );
    expect(session.pastes).toHaveLength(1);
    expect(session.pastes[0].text).toBe("Fix the crash in the parser and add a regression test.");
    expect(session.pastes[0].options).toEqual({ sendEnter: true });
    expect(session.toasts).toHaveLength(0);
    expect(session.cleanAgentPromptSpy).not.toHaveBeenCalled();
    expect(session.actionEngineMatch).not.toHaveBeenCalled();
    expect(session.isAgentSession()).toBe(false);
  });

  it("falls back with a notice when the rewrite times out", async () => {
    const session = createSession({ rewrite: async () => rewriteFailed("timeout") });

    await session.handleAgentStart();
    await session.complete("fix the bug send");

    expect(session.pastes[0].text).toBe(cleanAgentPrompt("fix the bug").text);
    expect(session.pastes[0].options).toEqual({ sendEnter: true });
    expect(session.toasts).toHaveLength(1);
    expect(session.toasts[0].title).toBe("Claude Code did not answer. Pasted as spoken.");
  });

  it("names the missing CLI when Claude Code is not found", async () => {
    const session = createSession({ rewrite: async () => rewriteFailed("not-found") });

    await session.handleAgentStart();
    await session.complete("fix the bug in the parser");

    expect(session.pastes[0].text).toBe(cleanAgentPrompt("fix the bug in the parser").text);
    expect(session.toasts).toHaveLength(1);
    expect(session.toasts[0].title).toBe("Claude Code not found. Pasted as spoken.");
  });

  it("stays silent when the main process reports the rewrite disabled", async () => {
    const session = createSession({ rewrite: async () => rewriteFailed("disabled") });

    await session.handleAgentStart();
    await session.complete("fix the bug in the parser");

    expect(session.pastes[0].text).toBe(cleanAgentPrompt("fix the bug in the parser").text);
    expect(session.toasts).toHaveLength(0);
  });

  it("never calls the bridge when the setting is off, and says nothing about it", async () => {
    const storage = createStorage();
    storage.setItem("agentModeRewrite", "false");
    const session = createSession({ storage, rewrite: async () => rewriteOk("rewritten") });

    await session.handleAgentStart();
    await session.complete("fix the bug in the parser send");

    expect(session.agentModeRewrite).not.toHaveBeenCalled();
    expect(session.pastes[0].text).toBe(cleanAgentPrompt("fix the bug in the parser").text);
    expect(session.pastes[0].options).toEqual({ sendEnter: true });
    expect(session.toasts).toHaveLength(0);
  });

  it("falls back with a notice when the bridge throws", async () => {
    const session = createSession({
      rewrite: async () => {
        throw new Error("preload bridge missing");
      },
    });

    await session.handleAgentStart();
    await session.complete("fix the bug in the parser");

    expect(session.pastes[0].text).toBe(cleanAgentPrompt("fix the bug in the parser").text);
    expect(session.toasts).toHaveLength(1);
    expect(session.toasts[0].title).toBe("Claude Code did not answer. Pasted as spoken.");
  });

  it("flags rewriting only while the bridge call is in flight", async () => {
    const seen: boolean[] = [];
    const session = createSession({
      rewrite: async () => {
        seen.push(session.isRewriting());
        return rewriteOk("Fix the parser.");
      },
    });

    expect(session.isRewriting()).toBe(false);
    await session.handleAgentStart();
    await session.complete("fix the parser");

    expect(seen).toEqual([true]);
    expect(session.isRewriting()).toBe(false);
  });

  it("clears the rewriting flag when the bridge throws", async () => {
    const seen: boolean[] = [];
    const session = createSession({
      rewrite: async () => {
        seen.push(session.isRewriting());
        throw new Error("spawn failed");
      },
    });

    await session.handleAgentStart();
    await session.complete("fix the parser");

    expect(seen).toEqual([true]);
    expect(session.isRewriting()).toBe(false);
  });

  it("drops the paste when the dictation is cancelled during the rewrite", async () => {
    const session = createSession({
      rewrite: async () => {
        session.denyCommit();
        return rewriteOk("Fix the parser.");
      },
    });

    await session.handleAgentStart();
    await session.complete("fix the parser send");

    expect(session.pastes).toHaveLength(0);
  });

  it("uses the fallback when no rewrite bridge is present at all", async () => {
    const session = createSession();

    await session.handleAgentStart();
    await session.complete("fix the bug send");

    expect(session.pastes).toHaveLength(1);
    expect(session.pastes[0].options).toEqual({ sendEnter: true });
    expect(session.pastes[0].text).toBe(cleanAgentPrompt("fix the bug send").text);
    expect(session.pastes[0].text.toLowerCase().endsWith("send")).toBe(false);
    expect(session.toasts).toHaveLength(0);
    expect(session.actionEngineMatch).not.toHaveBeenCalled();
  });

  it("leaves sendEnter off without a trailing send", async () => {
    const session = createSession();

    await session.handleAgentStart();
    await session.complete("fix the bug in the parser");

    expect(session.pastes[0].options).toEqual({});
    expect(session.pastes[0].options.sendEnter).toBeUndefined();
  });

  it("does not leak the flag from a cancelled agent session into the next dictation", async () => {
    const session = createSession({ rewrite: async () => rewriteOk("never used") });

    await session.handleAgentStart();
    expect(session.isAgentSession()).toBe(true);
    session.cancel();
    expect(session.isAgentSession()).toBe(false);

    await session.complete("open the file send");

    expect(session.agentModeRewrite).not.toHaveBeenCalled();
    expect(session.cleanAgentPromptSpy).not.toHaveBeenCalled();
    expect(session.pastes[0].text).toBe("open the file send");
    expect(session.pastes[0].options).toEqual({});
    expect(session.actionEngineMatch).toHaveBeenCalledTimes(1);
  });
});
