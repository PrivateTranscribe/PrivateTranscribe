import { describe, expect, it } from "vitest";
import {
  assistantText,
  stopHookLine,
  titleLine,
  toolResultLine,
  userLine,
  wrapUpLine,
} from "./narratorFixtures";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  TranscriptState,
  END_TURN_GRACE_MS,
} = require("../../../src/helpers/narrator/transcriptParser");

const T = Date.parse("2026-11-02T20:00:00Z");

function feed(lines: string[]) {
  const state = new TranscriptState();
  const events = lines.flatMap((line) => state.push(line, T + 60_000));
  return { state, events };
}

describe("narrator transcript parser", () => {
  it("reports a wait when wrap_up carries an ask and the stop hook closes the turn", () => {
    const { events } = feed([
      userLine("please fix the export", T),
      wrapUpLine({ recap: "The export is fixed. Not pushed.", ask: "Push it to main?" }, T + 1000),
      assistantText("Done.", T + 1100),
      stopHookLine(T + 1200),
    ]);
    const ended = events.filter((e: { type: string }) => e.type === "turn-ended");
    expect(ended).toHaveLength(1);
    expect(ended[0]).toMatchObject({
      waiting: true,
      recap: "The export is fixed. Not pushed.",
      ask: "Push it to main?",
      fromWrapUp: true,
    });
  });

  it("reports the wrap_up at once as the turn ending, before the turn has ended", () => {
    const state = new TranscriptState();
    const early = state.push(wrapUpLine({ recap: "Fixed.", ask: "Push?" }, T), T);
    expect(early).toEqual([
      {
        type: "turn-ending",
        waiting: true,
        recap: "Fixed.",
        ask: "Push?",
        at: T,
        fromWrapUp: true,
      },
    ]);
    expect(state.poll(T + END_TURN_GRACE_MS * 10)).toEqual([]);
    state.push(assistantText("Done.", T + 500), T + 500);
    expect(state.push(stopHookLine(T + 900), T + 900)).toEqual([
      expect.objectContaining({ type: "turn-ended", waiting: true, ask: "Push?", at: T + 500 }),
    ]);
  });

  it("treats blocked: true as waiting even without an ask", () => {
    const { events } = feed([
      wrapUpLine({ recap: "Stuck on a login.", blocked: true }, T),
      assistantText("Waiting.", T + 10),
      stopHookLine(T + 20),
    ]);
    expect(events.at(-1)).toMatchObject({ type: "turn-ended", waiting: true });
  });

  it("reports a finish when wrap_up has only a recap", () => {
    const { events } = feed([
      wrapUpLine({ recap: "Tests pass." }, T),
      assistantText("All good.", T + 10),
      stopHookLine(T + 20),
    ]);
    expect(events.at(-1)).toMatchObject({
      type: "turn-ended",
      waiting: false,
      recap: "Tests pass.",
    });
  });

  it("uses the last assistant text when a terminal chat has no wrap_up", () => {
    const { events } = feed([
      userLine("hi", T),
      assistantText("The build is green now.", T + 10),
      stopHookLine(T + 20),
    ]);
    expect(events.at(-1)).toMatchObject({
      type: "turn-ended",
      waiting: false,
      recap: "The build is green now.",
      fromWrapUp: false,
    });
  });

  it("does not end a turn that a Stop hook kept going", () => {
    const { events } = feed([assistantText("Done.", T), stopHookLine(T + 10, true)]);
    expect(events.filter((e: { type: string }) => e.type === "turn-ended")).toHaveLength(0);
  });

  it("voids an end_turn that is followed by more assistant work", () => {
    const state = new TranscriptState();
    state.push(assistantText("Done.", T), T);
    state.push(assistantText("Actually, one more step.", T + 100, "tool_use"), T + 100);
    expect(state.poll(T + END_TURN_GRACE_MS * 3)).toEqual([]);
  });

  it("ends a turn by grace when no stop hook line is ever written", () => {
    const state = new TranscriptState();
    state.push(wrapUpLine({ recap: "r", ask: "a?" }, T), T);
    state.push(assistantText("Done.", T + 10), T + 10);
    expect(state.poll(T + 10 + END_TURN_GRACE_MS - 1)).toEqual([]);
    expect(state.poll(T + 10 + END_TURN_GRACE_MS)).toMatchObject([
      { type: "turn-ended", waiting: true },
    ]);
  });

  it("gives a turn its end_turn time, whichever line closes it", () => {
    const viaHook = feed([
      wrapUpLine({ recap: "r", ask: "a?" }, T),
      assistantText("Done.", T + 10),
      stopHookLine(T + 5000),
    ]).events.at(-1);
    const state = new TranscriptState();
    state.push(wrapUpLine({ recap: "r", ask: "a?" }, T), T);
    state.push(assistantText("Done.", T + 10), T + 10);
    const [viaGrace] = state.poll(T + 10 + END_TURN_GRACE_MS);
    expect(viaHook.at).toBe(T + 10);
    expect(viaGrace.at).toBe(T + 10);
  });

  it("reports an answer only for text the person wrote", () => {
    const { events } = feed([
      toolResultLine(T),
      userLine("context", T + 1, { isMeta: true }),
      userLine("summary", T + 2, { isCompactSummary: true }),
      userLine("sub", T + 3, { isSidechain: true }),
      userLine("yes, push it", T + 4),
    ]);
    expect(events.filter((e: { type: string }) => e.type === "answered")).toHaveLength(1);
  });

  it("closes a pending turn before an answer that arrives inside the grace period", () => {
    const { events } = feed([
      wrapUpLine({ recap: "r", ask: "a?" }, T),
      assistantText("Done.", T + 10),
      userLine("yes", T + 20),
    ]);
    expect(events.map((e: { type: string }) => e.type)).toEqual([
      "turn-ending",
      "turn-ended",
      "answered",
    ]);
  });

  it("ignores subagent lines", () => {
    const { events } = feed([
      wrapUpLine({ recap: "sub", ask: "sub?" }, T, { isSidechain: true }),
      assistantText("sub done", T + 10, "end_turn", { isSidechain: true }),
      stopHookLine(T + 20),
    ]);
    expect(events.filter((e: { type: string }) => e.type === "turn-ended")).toHaveLength(0);
  });

  it("keeps the custom title and marks headless runs", () => {
    const { state, events } = feed([
      titleLine("Example chat"),
      assistantText("x", T, "end_turn", { entrypoint: "sdk-cli" }),
    ]);
    expect(events[0]).toEqual({ type: "title", title: "Example chat" });
    expect(state.title).toBe("Example chat");
    expect(state.headless).toBe(true);
  });

  it("skips lines that are not JSON", () => {
    const state = new TranscriptState();
    expect(state.push("{not json", T)).toEqual([]);
    expect(state.push("", T)).toEqual([]);
  });
});
