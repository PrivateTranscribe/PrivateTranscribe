/**
 * Synthetic Claude Code transcript lines, shaped like the real ones (Claude
 * Code 2.1.3xx). No real chat text, titles, names or paths.
 */

let counter = 0;
const ts = (ms: number) => new Date(ms).toISOString();

export const SESSION = "11111111-2222-4333-8444-555555555555";

export function userLine(text: string, at: number, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    parentUuid: null,
    isSidechain: false,
    type: "user",
    message: { role: "user", content: text },
    uuid: `u-${++counter}`,
    timestamp: ts(at),
    userType: "external",
    entrypoint: "claude-desktop",
    cwd: "C:\\work\\example-repo",
    sessionId: SESSION,
    ...extra,
  });
}

export function toolResultLine(at: number): string {
  return JSON.stringify({
    isSidechain: false,
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
    timestamp: ts(at),
    sessionId: SESSION,
  });
}

export function assistantText(
  text: string,
  at: number,
  stopReason: string | null = "end_turn",
  extra: Record<string, unknown> = {}
): string {
  return JSON.stringify({
    isSidechain: false,
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      stop_reason: stopReason,
    },
    timestamp: ts(at),
    entrypoint: "claude-desktop",
    sessionId: SESSION,
    ...extra,
  });
}

export function wrapUpLine(
  input: { recap?: string; ask?: string; blocked?: boolean },
  at: number,
  extra: Record<string, unknown> = {}
): string {
  return JSON.stringify({
    isSidechain: false,
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "tool_use", id: `w-${++counter}`, name: "mcp__ccd_turn__wrap_up", input }],
      stop_reason: "tool_use",
    },
    timestamp: ts(at),
    entrypoint: "claude-desktop",
    sessionId: SESSION,
    ...extra,
  });
}

export function stopHookLine(at: number, preventedContinuation = false): string {
  return JSON.stringify({
    isSidechain: false,
    type: "system",
    subtype: "stop_hook_summary",
    hookCount: 3,
    preventedContinuation,
    timestamp: ts(at),
    sessionId: SESSION,
  });
}

export function titleLine(title: string): string {
  return JSON.stringify({ type: "custom-title", customTitle: title, sessionId: SESSION });
}
