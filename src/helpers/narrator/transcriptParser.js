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
 *
 * The wrap_up call comes before all that: the closing words still stream and
 * the Stop hooks still run, seconds in all. Its recap and ask are final when
 * it is made, so it is reported at once as "turn-ending", for work that can
 * start early. Only "turn-ended" says the turn is over.
 *
 * A turn in which the chat asked by voice (PrivateTranscribe's ask_by_voice
 * tool, under any server name), and the question was spoken but not answered,
 * is marked `voiceAsked`: the chat now waits on a question that was said
 * already, so it is not said again. A pick that came back clears the mark, as
 * the chat carries on and a later wait is a new question. A call answered
 * "not_active" spoke nothing and changes nothing.
 */

const WRAP_UP_TOOL = "mcp__ccd_turn__wrap_up";
const ASK_BY_VOICE_TOOL = "ask_by_voice";
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

function isAskByVoice(name) {
  return (
    typeof name === "string" &&
    (name === ASK_BY_VOICE_TOOL || name.endsWith(`__${ASK_BY_VOICE_TOOL}`))
  );
}

/**
 * What an ask_by_voice result means for the chat's wait: "open" when the
 * question was spoken and nothing was picked, "answered" when a pick came
 * back, null when nothing was said ("not_active", or an error from the tool).
 */
function voiceOutcome(content) {
  const text = typeof content === "string" ? content : textOf(contentBlocks({ content }));
  let result;
  try {
    result = JSON.parse(text);
  } catch {
    // An error from the tool, such as a refused input: nothing was said.
    return null;
  }
  if (!result || typeof result !== "object" || !("answer" in result)) return null;
  if (typeof result.answer === "string" && result.answer) return "answered";
  return result.reason === "not_active" ? null : "open";
}

/**
 * Whether a raw line can matter, decided without parsing it. Most of a
 * transcript's bytes are attachment and api-request lines (measured: 280 of
 * 334 MB), which never do. A marker found here is structure, not text: inside
 * a JSON string every quote is escaped, so `"type":"user"` cannot come from
 * what someone wrote. A tool result is never something the person wrote; the
 * only results read are those that can be ask_by_voice's, whose text holds an
 * escaped `"answer":`.
 */
function isRelevantLine(line) {
  if (line.includes('"type":"user"')) {
    return !line.includes('"type":"tool_result"') || line.includes('\\"answer\\":');
  }
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
 *   { type: "turn-ending", waiting, recap, ask, at, fromWrapUp, voiceAsked }   the wrap_up call; `at` is its line's
 *   { type: "turn-ended", waiting, recap, ask, at, fromWrapUp, voiceAsked }
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
    /** ask_by_voice calls of this turn still waiting for their result, by tool_use id. */
    this.voiceAskIds = new Set();
    /** Whether this turn spoke a question through ask_by_voice. */
    this.voiceAsked = false;
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
        if (block?.type === "tool_use" && isAskByVoice(block.name) && block.id) {
          this.voiceAskIds.add(block.id);
        }
        if (block?.type === "tool_use" && block.name === WRAP_UP_TOOL) {
          const input = block.input || {};
          this.wrapUp = {
            recap: clip(input.recap, MAX_FIELD),
            ask: clip(input.ask, MAX_FIELD),
            blocked: input.blocked === true,
          };
          events.push({ ...this._turn(at), type: "turn-ending" });
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

    if (record.type === "user" && this.voiceAskIds.size > 0) {
      for (const block of contentBlocks(record.message)) {
        if (block?.type !== "tool_result" || !this.voiceAskIds.has(block.tool_use_id)) continue;
        this.voiceAskIds.delete(block.tool_use_id);
        const outcome = voiceOutcome(block.content);
        if (outcome === "open") this.voiceAsked = true;
        else if (outcome === "answered") this.voiceAsked = false;
      }
    }

    if (isPersonText(record)) {
      this.lastActivityAt = at;
      // A new message from the user before the turn was closed still closes it
      // first, so a finish is never lost to a fast reply.
      if (this.endTurnAt !== null) events.push(this._endTurn(this.endTurnAt));
      this.wrapUp = null;
      this.lastAssistantText = "";
      this.voiceAskIds.clear();
      this.voiceAsked = false;
      events.push({ type: "answered", at });
    }
    return events;
  }

  /** Ends a turn whose end_turn has been quiet for the grace period. */
  poll(now) {
    if (this.endTurnAt === null || now - this.endTurnAt < END_TURN_GRACE_MS) return [];
    return [this._endTurn(this.endTurnAt)];
  }

  /** What the turn says so far, as a turn ending at `at`. */
  _turn(at) {
    const wrapUp = this.wrapUp;
    return {
      type: "turn-ended",
      waiting: Boolean(wrapUp && (wrapUp.ask || wrapUp.blocked)),
      recap: wrapUp?.recap || clip(this.lastAssistantText, MAX_FALLBACK_RECAP),
      ask: wrapUp?.ask || "",
      at,
      fromWrapUp: Boolean(wrapUp),
      voiceAsked: this.voiceAsked,
    };
  }

  _endTurn(at) {
    const event = this._turn(at);
    this.endTurnAt = null;
    this.wrapUp = null;
    this.voiceAsked = false;
    return event;
  }
}

module.exports = {
  TranscriptState,
  parseLine,
  isRelevantLine,
  isPersonText,
  isAskByVoice,
  WRAP_UP_TOOL,
  END_TURN_GRACE_MS,
  HEADLESS_ENTRYPOINTS,
};
