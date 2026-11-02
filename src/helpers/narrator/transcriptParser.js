"use strict";

/**
 * Reads Claude Code transcript lines (one JSON object per line, as written to
 * ~/.claude/projects/<project>/<session>.jsonl) and turns them into the few
 * events the narrator cares about. Pure: no files, no timers, no clock of its
 * own, so every rule here is tested with synthetic lines.
 *
 * What a turn looks like on disk, checked against real transcripts written by
 * Claude Code 2.1.3xx (desktop app and terminal):
 *
 *   user        text the person typed (not a tool_result, not isMeta)
 *   assistant   ... tool_use mcp__ccd_turn__wrap_up {recap, ask?, blocked?}
 *   assistant   stop_reason "end_turn"
 *   system      subtype "stop_hook_summary"   (only when Stop hooks exist)
 *
 * The desktop app's wrap_up call is the best material there is: its recap and
 * ask were already written short, for the person. A chat waits on the user when the
 * call carries an `ask` or `blocked: true`. A terminal chat has no wrap_up, so
 * its last assistant text stands in for the recap.
 *
 * The turn ends at the stop_hook_summary line. A machine without Stop hooks
 * never writes one, so an end_turn with nothing after it for END_TURN_GRACE_MS
 * also ends the turn; the source calls poll() with its clock to find those.
 * Either way the turn's time is its end_turn line's, so the same turn read
 * twice carries the same time.
 */

const WRAP_UP_TOOL = "mcp__ccd_turn__wrap_up";
/** Quiet after end_turn that counts as the end of a turn with no Stop hook. */
const END_TURN_GRACE_MS = 4000;
/** Longest last-message text kept as a terminal chat's recap. */
const MAX_FALLBACK_RECAP = 1200;
/** Longest wrap_up field kept; real ones run to a few hundred characters. */
const MAX_FIELD = 2000;

/**
 * Entry points of headless runs: `claude -p`, the Agent SDK, Converse. They
 * are programs talking to Claude, not chats waiting on a person, and the
 * narrator's own rewriter is one of them.
 */
const HEADLESS_ENTRYPOINTS = new Set(["sdk-cli", "sdk-ts", "sdk-py", "print"]);

function clip(value, max) {
  if (typeof value !== "string") return "";
  const text = value.trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

function contentBlocks(message) {
  const content = message?.content;
  if (typeof content === "string") return [{ type: "text", text: content }];
  return Array.isArray(content) ? content : [];
}

function textOf(blocks) {
  return blocks
    .filter((block) => block && block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

function timeOf(record, fallback) {
  const parsed = Date.parse(record?.timestamp || "");
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Whether a raw line can matter, decided without parsing it. Most of a
 * transcript's bytes are attachment and api-request lines (measured: 280 of
 * 334 MB), which never do. A marker found here is structure, not text: inside
 * a JSON string every quote is escaped, so `"type":"user"` cannot come from
 * what someone wrote. A tool result is never something the person wrote.
 */
function isRelevantLine(line) {
  if (line.includes('"type":"user"')) return !line.includes('"type":"tool_result"');
  return (
    line.includes('"type":"assistant"') ||
    line.includes('"stop_hook_summary"') ||
    line.includes('"type":"custom-title"') ||
    line.includes('"type":"ai-title"')
  );
}

/** One line of text as a record, or null when it is not JSON or cannot matter. */
function parseLine(line) {
  if (typeof line !== "string" || !line.trim() || !isRelevantLine(line)) return null;
  try {
    const record = JSON.parse(line);
    return record && typeof record === "object" ? record : null;
  } catch {
    return null;
  }
}

/** Text the person wrote, as opposed to tool results and app-injected lines. */
function isPersonText(record) {
  if (record.type !== "user" || record.isSidechain) return false;
  if (record.isMeta || record.isCompactSummary || record.isVisibleInTranscriptOnly) return false;
  const blocks = contentBlocks(record.message);
  if (blocks.some((block) => block?.type === "tool_result")) return false;
  return textOf(blocks).length > 0;
}

/**
 * The state of one chat's transcript. Feed it every line in order; each call
 * returns the events that line completes.
 *
 * Events:
 *   { type: "title", title }
 *   { type: "turn-ended", waiting, recap, ask, at, fromWrapUp }
 *   { type: "answered", at }        the person wrote in the chat again
 */
class TranscriptState {
  constructor() {
    this.title = "";
    this.cwd = "";
    this.headless = false;
    this.wrapUp = null;
    this.lastAssistantText = "";
    this.endTurnAt = null;
    this.lastActivityAt = 0;
  }

  /** @param {string|object} lineOrRecord */
  push(lineOrRecord, now = Date.now()) {
    const record = typeof lineOrRecord === "string" ? parseLine(lineOrRecord) : lineOrRecord;
    if (!record) return [];
    const events = [];
    const at = timeOf(record, now);

    if (typeof record.entrypoint === "string" && HEADLESS_ENTRYPOINTS.has(record.entrypoint)) {
      this.headless = true;
    }
    if (typeof record.cwd === "string" && record.cwd) this.cwd = record.cwd;

    if (record.type === "custom-title" || record.type === "ai-title") {
      const title = clip(record.customTitle || record.aiTitle || record.title, 200);
      if (title && title !== this.title && (record.type === "custom-title" || !this.title)) {
        this.title = title;
        events.push({ type: "title", title });
      }
      return events;
    }

    if (record.isSidechain) return events;

    if (record.type === "assistant") {
      this.lastActivityAt = at;
      const blocks = contentBlocks(record.message);
      for (const block of blocks) {
        if (block?.type === "tool_use" && block.name === WRAP_UP_TOOL) {
          const input = block.input || {};
          this.wrapUp = {
            recap: clip(input.recap, MAX_FIELD),
            ask: clip(input.ask, MAX_FIELD),
            blocked: input.blocked === true,
          };
        }
      }
      const text = textOf(blocks);
      if (text) this.lastAssistantText = text;
      // A later assistant line after an end_turn means the turn went on (a
      // Stop hook that blocked, a queued message): the earlier end is void.
      this.endTurnAt = record.message?.stop_reason === "end_turn" ? at : null;
      return events;
    }

    if (record.type === "system" && record.subtype === "stop_hook_summary") {
      if (this.endTurnAt !== null && !record.preventedContinuation) {
        events.push(this._endTurn(this.endTurnAt));
      }
      return events;
    }

    if (isPersonText(record)) {
      this.lastActivityAt = at;
      // A new message from the user before the turn was closed still closes it
      // first, so a finish is never lost to a fast reply.
      if (this.endTurnAt !== null) events.push(this._endTurn(this.endTurnAt));
      this.wrapUp = null;
      this.lastAssistantText = "";
      events.push({ type: "answered", at });
    }
    return events;
  }

  /** Ends a turn whose end_turn has been quiet for the grace period. */
  poll(now) {
    if (this.endTurnAt === null || now - this.endTurnAt < END_TURN_GRACE_MS) return [];
    return [this._endTurn(this.endTurnAt)];
  }

  _endTurn(at) {
    const wrapUp = this.wrapUp;
    const recap = wrapUp?.recap || clip(this.lastAssistantText, MAX_FALLBACK_RECAP);
    const ask = wrapUp?.ask || "";
    const event = {
      type: "turn-ended",
      waiting: Boolean(wrapUp && (wrapUp.ask || wrapUp.blocked)),
      recap,
      ask,
      at,
      fromWrapUp: Boolean(wrapUp),
    };
    this.endTurnAt = null;
    this.wrapUp = null;
    return event;
  }
}

module.exports = {
  TranscriptState,
  parseLine,
  isRelevantLine,
  isPersonText,
  WRAP_UP_TOOL,
  END_TURN_GRACE_MS,
  HEADLESS_ENTRYPOINTS,
};
