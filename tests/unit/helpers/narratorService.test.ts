import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SESSION,
  assistantText,
  stopHookLine,
  titleLine,
  userLine,
  wrapUpLine,
} from "./narratorFixtures";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { Narrator } = require("../../../src/helpers/narrator");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  ClaudeTranscriptSource,
  splitLines,
} = require("../../../src/helpers/narrator/claudeTranscriptSource");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { DesktopSessionIndex } = require("../../../src/helpers/narrator/desktopSessionIndex");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { NarratorLog } = require("../../../src/helpers/narrator/narratorLog");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { templateRewrite } = require("../../../src/helpers/narrator/rewriter");

type Item = Record<string, unknown>;
type Played = { chime: boolean; texts: string[]; ended: boolean; cancelled: boolean };

const DAY_MS = 24 * 60 * 60 * 1000;
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

/** A voice that hands each sentence's text along with its PCM, so a test can read what was said. */
function fakeVoice(id: string, synthesize?: (text: string) => Promise<object>) {
  return {
    id,
    synthesize: vi.fn(
      synthesize ||
        (async (text: string) => ({ pcm: new Float32Array(text.length), sampleRate: 22050, text }))
    ),
    warm: vi.fn(),
    unload: vi.fn(),
  };
}

/**
 * The overlay's side of playback. Each playback starts with its first sound
 * and finishes when it ends, or, with `hold`, when the test says so.
 */
function fakeOverlay({ hold = false } = {}) {
  const played: Played[] = [];
  const finishers: ((state: string) => void)[] = [];
  const openPlayback = ({ chime }: { chime: boolean }) => {
    const record: Played = { chime, texts: [], ended: false, cancelled: false };
    played.push(record);
    let start: (at: number | null) => void = () => {};
    let finish: (state: string) => void = () => {};
    const started = new Promise<number | null>((resolve) => {
      start = resolve;
    });
    const result = new Promise<string>((resolve) => {
      finish = (state) => {
        start(null);
        resolve(state);
      };
    });
    finishers.push(finish);
    return {
      push: (part: { text: string }) => {
        record.texts.push(part.text);
        start(Date.now());
      },
      end: () => {
        record.ended = true;
        if (chime) start(Date.now());
        if (!hold) finish("done");
      },
      cancel: () => {
        record.cancelled = true;
        finish("stopped");
      },
      started,
      result,
    };
  };
  return {
    played,
    openPlayback,
    /** The words of each playback that had words, in order. */
    spoken: () => played.filter((p) => p.texts.length > 0).map((p) => p.texts.join(" ")),
    finish: (index: number, state = "done") => finishers[index](state),
  };
}

function startNarrator(
  dataDir: string | null,
  {
    voices = { "piper-da": fakeVoice("piper-da"), "kokoro-en": fakeVoice("kokoro-en") },
    overlay = fakeOverlay(),
  }: {
    voices?: Record<string, ReturnType<typeof fakeVoice>>;
    overlay?: ReturnType<typeof fakeOverlay>;
  } = {}
) {
  let emit: (event: object) => void = () => {};
  const source = { start: vi.fn(), stop: vi.fn() };
  const rewriter = {
    lastError: null,
    warm: vi.fn(),
    close: vi.fn(),
    rewrite: vi.fn(async (item: Item, language: string) => templateRewrite(item, language)),
    rewriteMany: vi.fn(async (items: Item[], language: string) =>
      items.map((item) => templateRewrite(item, language))
    ),
  };
  const opened: string[] = [];
  const narrator = new Narrator({
    dataDir,
    openPlayback: overlay.openPlayback,
    voices,
    createSource: (onEvent: (event: object) => void) => {
      emit = onEvent;
      return source;
    },
    rewriter,
    openUrl: (url: string) => opened.push(url),
  });
  narrator.updateSettings({ enabled: true });
  narrator.setGate(true);
  return {
    narrator,
    overlay,
    voices,
    source,
    rewriter,
    opened,
    emit: (event: object) => emit(event),
  };
}

const wait = (chatId: string, chatTitle: string, ask: string, extra: Item = {}) => ({
  kind: "waiting",
  chatId,
  chatTitle,
  ask,
  recap: "",
  at: Date.now(),
  ...extra,
});

describe("narrator service", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-narrator-"));
  });
  afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("runs only when both its own switch and the Experimental switch are on", () => {
    const { narrator, source } = startNarrator(dir);
    expect(source.start).toHaveBeenCalledTimes(1);
    narrator.setGate(false);
    expect(source.stop).toHaveBeenCalledTimes(1);
    expect(narrator.running).toBe(false);
    narrator.updateSettings({ enabled: false });
    narrator.setGate(true);
    expect(source.start).toHaveBeenCalledTimes(1);
  });

  it("forgets its cards and lets go of the voices and the rewriter when switched off", () => {
    const { narrator, voices, rewriter, emit } = startNarrator(dir);
    emit({ kind: "finished", chatId: "c1", chatTitle: "A", recap: "Done.", at: Date.now() });
    expect(narrator.getState().items).toHaveLength(1);
    narrator.setGate(false);
    expect(narrator.getState().items).toHaveLength(0);
    expect(rewriter.close).toHaveBeenCalled();
    expect(voices["piper-da"].unload).toHaveBeenCalled();
  });

  it("chimes the moment a wait arrives, then speaks it in Danish and logs it", async () => {
    const { narrator, overlay, emit } = startNarrator(dir);
    emit(wait("c1", "Export fix", "Push to main?"));
    // The chime went out before the rewrite came back.
    expect(overlay.played).toEqual([expect.objectContaining({ chime: true, texts: [] })]);
    await vi.waitFor(() =>
      expect(overlay.spoken()).toEqual(["Export fix venter på dig. Push to main?"])
    );
    expect(overlay.played[1].chime).toBe(false);
    await vi.waitFor(() => expect(narrator.getState().week.interrupt).toBe(1));
    expect(narrator.getState().week.card).toBe(1);
    expect(narrator.getState().lastPlayback).toMatchObject({
      result: "done",
      chime: true,
      language: "da",
    });
    expect(narrator.getState().lastPlayback.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("starts a wait's words at its wrap_up, and makes no sound until its turn ends", async () => {
    const { narrator, overlay, rewriter, emit } = startNarrator(dir);
    emit(wait("c1", "Build", "Retry?", { provisional: true }));
    emit({
      kind: "finished",
      chatId: "c2",
      chatTitle: "Docs",
      recap: "Done.",
      at: Date.now(),
      provisional: true,
    });
    // Only the wait is rewritten early: a finish nobody follows is never spoken.
    expect(rewriter.rewrite).toHaveBeenCalledTimes(1);
    expect(overlay.played).toHaveLength(0);
    expect(narrator.getState().items).toHaveLength(0);

    emit(wait("c1", "Build", "Retry?"));
    await vi.waitFor(() => expect(overlay.spoken()).toEqual(["Build venter på dig. Retry?"]));
    expect(rewriter.rewrite).toHaveBeenCalledTimes(1);
  });

  it("rewrites a wait again when its words changed after the wrap_up", async () => {
    const { overlay, rewriter, emit } = startNarrator(dir);
    emit(wait("c1", "Build", "Retry?", { provisional: true }));
    emit(wait("c1", "Build", "Retry on main?"));
    await vi.waitFor(() =>
      expect(overlay.spoken()).toEqual(["Build venter på dig. Retry on main?"])
    );
    expect(rewriter.rewrite).toHaveBeenCalledTimes(2);
  });

  it("chimes a wait queued behind speech when its turn comes, then speaks it", async () => {
    const overlay = fakeOverlay({ hold: true });
    const { narrator, emit } = startNarrator(dir, { overlay });
    narrator.test("da");
    expect(overlay.played).toHaveLength(1);
    emit(wait("c1", "Build", "Retry?"));
    expect(overlay.played).toHaveLength(1);
    overlay.finish(0);
    await vi.waitFor(() => expect(overlay.played).toHaveLength(2));
    expect(overlay.played[1]).toMatchObject({ chime: true, texts: [] });
    overlay.finish(1);
    await vi.waitFor(() => expect(overlay.played[2]?.ended).toBe(true));
    expect(overlay.played[2]).toMatchObject({ chime: false });
    expect(overlay.spoken().at(-1)).toBe("Build venter på dig. Retry?");
  });

  it("keeps a queued wait new when only its chime played", async () => {
    const voice = fakeVoice("piper-da", async (text) => {
      if (text.startsWith("B ")) throw new Error("The voice broke");
      return { pcm: new Float32Array(4), sampleRate: 22050, text };
    });
    const { narrator, overlay, emit } = startNarrator(dir, { voices: { "piper-da": voice } });
    emit(wait("c1", "A", "One?"));
    emit(wait("c2", "B", "Two?"));
    await vi.waitFor(() =>
      expect(narrator.getState().voiceError).toMatchObject({ message: "The voice broke" })
    );
    const heard = Object.fromEntries(
      narrator
        .getState()
        .items.map((item: { chatId: string; heard: boolean }) => [item.chatId, item.heard])
    );
    expect(heard).toEqual({ c1: true, c2: false });
    expect(overlay.played.filter((p) => p.chime && p.texts.length === 0)).toHaveLength(2);
  });

  it("drops a wait's held chime when the user answers first", async () => {
    const overlay = fakeOverlay({ hold: true });
    const { narrator, emit } = startNarrator(dir, { overlay });
    emit(wait("c1", "A", "Push?"));
    emit({ kind: "answered", chatId: "c1", at: Date.now() });
    expect(overlay.played[0]).toMatchObject({ chime: true, cancelled: true });
    await settle();
    expect(overlay.played).toHaveLength(1);
    expect(narrator.getState().items).toHaveLength(0);
  });

  it("stops the item being made when told to, and drops what was queued", async () => {
    let release: () => void = () => {};
    const slow = fakeVoice(
      "piper-da",
      (text) =>
        new Promise((resolve) => {
          release = () => resolve({ pcm: new Float32Array(4), sampleRate: 22050, text });
        })
    );
    const { narrator, overlay, emit } = startNarrator(dir, { voices: { "piper-da": slow } });
    emit(wait("c1", "A", "One?"));
    emit(wait("c2", "B", "Two?"));
    await vi.waitFor(() => expect(slow.synthesize).toHaveBeenCalledTimes(1));
    narrator.stop();
    release();
    await settle();
    expect(overlay.spoken()).toEqual([]);
    expect(overlay.played.at(-1)?.cancelled).toBe(true);
    expect(slow.synthesize).toHaveBeenCalledTimes(1);
    expect(narrator.getState().queued).toBe(0);
  });

  it("cuts off an item when the user answers in its chat", async () => {
    const overlay = fakeOverlay({ hold: true });
    const { narrator, emit } = startNarrator(dir, { overlay });
    emit(wait("c1", "A", "Push?"));
    overlay.finish(0);
    await vi.waitFor(() => expect(overlay.played[1]?.ended).toBe(true));
    emit({ kind: "answered", chatId: "c1", at: Date.now() });
    expect(overlay.played[1].cancelled).toBe(true);
    expect(narrator.getState().items).toHaveLength(0);
  });

  it("does not speak a wait the user answered before its turn came", async () => {
    const { narrator, overlay, emit } = startNarrator(dir);
    narrator.test("da");
    emit(wait("c4", "X", "Y?"));
    emit({ kind: "answered", chatId: "c4", at: Date.now() });
    await settle();
    expect(overlay.spoken()).toEqual(["Hej. Sådan lyder fortælleren, når en chat venter på dig."]);
  });

  it("keeps finishes as cards and speaks them in one brief, in the language asked", async () => {
    const { narrator, overlay, rewriter, emit } = startNarrator(dir);
    emit({ kind: "finished", chatId: "c2", chatTitle: "Docs", recap: "Docs updated. Two.", at: 2 });
    emit({ kind: "finished", chatId: "c3", chatTitle: "Tests", recap: "All green.", at: 3 });
    expect(overlay.played).toHaveLength(0);
    expect(narrator.getState().week.card).toBe(2);

    narrator.handleUtterance("What's new?");
    await vi.waitFor(() => expect(overlay.spoken()).toHaveLength(1));
    expect(overlay.spoken()[0]).toBe(
      "There are 2 new things. Tests has finished. All green. Docs has finished. Docs updated."
    );
    expect(rewriter.rewriteMany).toHaveBeenCalledTimes(1);
    expect(rewriter.rewriteMany.mock.calls[0][0]).toHaveLength(2);
    expect(narrator.getState().items.every((item: { heard: boolean }) => item.heard)).toBe(true);

    narrator.handleUtterance("hvad er nyt");
    await vi.waitFor(() => expect(overlay.spoken()).toHaveLength(2));
    expect(overlay.spoken()[1]).toBe("Der er ikke noget nyt.");
    await vi.waitFor(() => expect(narrator.getState().week.brief).toBe(2));
  });

  it("files a wait found at startup as a card, without a sound and without counting it", () => {
    const { narrator, overlay, emit } = startNarrator(dir);
    emit(wait("c1", "A", "Old?", { at: Date.now() - 60_000, backlog: true }));
    expect(overlay.played).toHaveLength(0);
    expect(narrator.getState().items[0]).toMatchObject({ kind: "waiting", heard: false });
    expect(narrator.getState().week.card).toBeUndefined();
  });

  it("follows the chat heard last, and then speaks its finishes", async () => {
    const { narrator, overlay, emit } = startNarrator(dir);
    emit(wait("c3", "Build", "Retry?"));
    await vi.waitFor(() => expect(overlay.spoken()).toHaveLength(1));
    narrator.handleUtterance("Følg den chat");
    await vi.waitFor(() => expect(overlay.spoken().at(-1)).toBe("Jeg følger Build nu."));
    emit({ kind: "answered", chatId: "c3", at: Date.now() });
    emit({
      kind: "finished",
      chatId: "c3",
      chatTitle: "Build",
      recap: "Green.",
      at: Date.now() + 1,
    });
    await vi.waitFor(() => expect(overlay.spoken().at(-1)).toBe("Build er færdig. Green."));
    expect(overlay.played.at(-1)?.chime).toBe(false);
  });

  it("hands Danish to Piper when Røst fails, and stays on Piper for a while", async () => {
    const roest = fakeVoice("roest-da", async () => {
      throw new Error("no graphics card");
    });
    const piper = fakeVoice("piper-da");
    const { narrator, overlay, emit } = startNarrator(dir, {
      voices: { "roest-da": roest, "piper-da": piper },
    });
    narrator.updateSettings({ voiceDa: "roest-da" });
    emit(wait("c1", "A", "One?"));
    await vi.waitFor(() => expect(overlay.spoken()).toEqual(["A venter på dig. One?"]));
    emit(wait("c2", "B", "Two?"));
    await vi.waitFor(() => expect(overlay.spoken()).toHaveLength(2));
    expect(roest.synthesize).toHaveBeenCalledTimes(1);
    expect(roest.unload).toHaveBeenCalled();
    expect(narrator.getState().voiceError).toBeNull();
  });

  it("gives up on a voice that hangs and is ready for the next item", async () => {
    vi.useFakeTimers();
    const hung = fakeVoice("piper-da", () => new Promise(() => {}));
    const { narrator, emit } = startNarrator(dir, { voices: { "piper-da": hung } });
    emit(wait("c1", "A", "One?"));
    await vi.advanceTimersByTimeAsync(16_000);
    expect(narrator.getState().voiceError).toMatchObject({ code: "timeout" });
    expect(narrator.getState().speaking).toBeNull();
    expect(narrator.getState().queued).toBe(0);
  });

  it("still chimes when the voice fails, and keeps the item new for the next brief", async () => {
    const broken = fakeVoice("piper-da", async () => {
      throw Object.assign(new Error("The Danish voice is not downloaded"), {
        code: "voice-missing",
      });
    });
    const { narrator, overlay, emit } = startNarrator(dir, { voices: { "piper-da": broken } });
    emit(wait("c1", "A", "Push?"));
    await vi.waitFor(() =>
      expect(narrator.getState().voiceError).toMatchObject({ code: "voice-missing" })
    );
    expect(overlay.played[0]).toMatchObject({ chime: true, ended: true });
    expect(narrator.getState().items[0].heard).toBe(false);
    expect(narrator.getState().week.interrupt).toBeUndefined();
  });

  it("opens only a desktop chat address", () => {
    const { narrator, opened } = startNarrator(dir);
    const good = narrator.ingest({
      kind: "finished",
      chatId: "a",
      recap: "r",
      openUrl: "claude://claude.ai/epitaxy/local_613d00cc-98b6-4bcd-8c4a-5466c71eb33f",
    }).item;
    const bad = narrator.ingest({
      kind: "finished",
      chatId: "b",
      recap: "r",
      openUrl: "https://evil.example",
    }).item;
    expect(narrator.open(good.id)).toBe(true);
    expect(narrator.open(bad.id)).toBe(false);
    expect(opened).toHaveLength(1);
  });

  it("remembers its settings and followed chats, and leaves barge-in off by default", () => {
    const first = startNarrator(dir).narrator;
    expect(first.getState().settings.bargeIn).toBe(false);
    first.updateSettings({ language: "en", listen: true });
    first.follow("c9");
    const second = startNarrator(dir).narrator;
    expect(second.getState().settings).toMatchObject({
      enabled: true,
      language: "en",
      listen: true,
      followed: ["c9"],
    });
    expect(second.router.isFollowed("c9")).toBe(true);
  });
});

describe("narrator log", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-narrator-log-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("reads the file once, then counts the week from memory", () => {
    const file = path.join(dir, "narrator-log.jsonl");
    const line = (ageMs: number, kind: string) =>
      JSON.stringify({ at: new Date(Date.now() - ageMs).toISOString(), kind });
    fs.writeFileSync(
      file,
      `${line(8 * DAY_MS, "interrupt")}\n${line(60_000, "interrupt")}\n{torn\n`
    );
    const log = new NarratorLog(file);
    const week = () => log.countSince(Date.now() - 7 * DAY_MS);
    expect(week()).toEqual({ interrupt: 1 });
    fs.rmSync(file);
    log.append({ kind: "card" });
    expect(week()).toEqual({ interrupt: 1, card: 1 });
    expect(fs.readFileSync(file, "utf8")).toContain('"kind":"card"');
  });
});

describe("Claude transcript source", () => {
  let root: string;
  let sessions: string;
  let file: string;
  const events: Record<string, unknown>[] = [];
  /** Each event's kind; one reported early from its wrap_up reads "waiting (early)". */
  const kinds = () =>
    events.map((event) => (event.provisional ? `${event.kind} (early)` : event.kind));

  const writeRecord = (fields: Record<string, unknown>) => {
    fs.mkdirSync(path.join(sessions, "acct", "org"), { recursive: true });
    fs.writeFileSync(
      path.join(sessions, "acct", "org", "local_613d00cc-98b6-4bcd-8c4a-5466c71eb33f.json"),
      JSON.stringify({
        sessionId: "local_613d00cc-98b6-4bcd-8c4a-5466c71eb33f",
        cliSessionId: SESSION,
        isArchived: false,
        ...fields,
      })
    );
  };
  const lines = (...all: string[]) => all.map((line) => `${line}\n`).join("");
  const newSource = (sessionIndex: unknown = null) =>
    new ClaudeTranscriptSource({
      root,
      onEvent: (event: Record<string, unknown>) => events.push(event),
      sessionIndex,
    });

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "pt-narrator-projects-"));
    sessions = fs.mkdtempSync(path.join(os.tmpdir(), "pt-narrator-sessions-"));
    fs.mkdirSync(path.join(root, "C--work-example-repo"));
    file = path.join(root, "C--work-example-repo", `${SESSION}.jsonl`);
    events.length = 0;
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(sessions, { recursive: true, force: true });
  });

  it("emits a live wait with the desktop app's title and chat address, then the answer", async () => {
    const now = Date.now();
    fs.writeFileSync(file, lines(titleLine("Transcript title"), userLine("go", now - 1000)));
    writeRecord({ title: "App title", originCwd: "C:\\work\\example-repo" });
    const source = newSource(new DesktopSessionIndex({ roots: [sessions] }));
    await source.start();
    await source.readFile(file);
    expect(kinds()).toEqual(["answered"]);

    fs.appendFileSync(
      file,
      lines(
        wrapUpLine({ recap: "Fixed.", ask: "Push?" }, now),
        assistantText("Done.", now),
        stopHookLine(now)
      )
    );
    await source.readFile(file);
    await vi.waitFor(() => expect(kinds()).toEqual(["answered", "waiting (early)", "waiting"]));
    const wait = {
      chatId: SESSION,
      chatTitle: "App title",
      project: "example-repo",
      recap: "Fixed.",
      ask: "Push?",
      backlog: false,
      openUrl: "claude://claude.ai/epitaxy/local_613d00cc-98b6-4bcd-8c4a-5466c71eb33f",
    };
    expect(events[1]).toMatchObject({ ...wait, provisional: true });
    expect(events[2]).toMatchObject(wait);
    expect(events[2].provisional).toBeUndefined();

    fs.appendFileSync(file, lines(userLine("yes", now + 10)));
    await source.readFile(file);
    expect(kinds()).toEqual(["answered", "waiting (early)", "waiting", "answered"]);
    source.stop();
  });

  it("files a wait already open at startup as backlog, found through the app's record", async () => {
    const at = Date.now() - 60_000;
    fs.writeFileSync(
      file,
      lines(
        titleLine("T"),
        wrapUpLine({ recap: "R", ask: "A?" }, at),
        assistantText("x", at),
        stopHookLine(at)
      )
    );
    writeRecord({ title: "", cwd: "C:\\work\\example-repo", lastActivityAt: at });
    const source = newSource(new DesktopSessionIndex({ roots: [sessions] }));
    await source.start();
    source.stop();
    expect(events).toEqual([
      expect.objectContaining({ kind: "waiting", backlog: true, chatTitle: "T", ask: "A?" }),
    ]);
  });

  it("drops a turn that was answered in the same read", async () => {
    const now = Date.now();
    fs.writeFileSync(
      file,
      lines(
        wrapUpLine({ recap: "R", ask: "A?" }, now),
        assistantText("x", now),
        stopHookLine(now),
        userLine("yes", now + 5)
      )
    );
    const source = newSource();
    await source.start();
    await source.readFile(file);
    await settle();
    source.stop();
    expect(kinds()).toEqual(["answered"]);
  });

  it("waits for the rest of a half-written line, even one cut inside a letter", async () => {
    const now = Date.now();
    const line = wrapUpLine({ recap: "R", ask: "Skal jeg køre den?" }, now);
    const bytes = Buffer.from(line, "utf8");
    const cut = bytes.indexOf(Buffer.from("ø", "utf8")) + 1;
    fs.writeFileSync(file, bytes.subarray(0, cut));
    const source = newSource();
    await source.start();
    await source.readFile(file);
    fs.appendFileSync(
      file,
      Buffer.concat([
        bytes.subarray(cut),
        Buffer.from(lines("", assistantText("x", now), stopHookLine(now))),
      ])
    );
    await source.readFile(file);
    await vi.waitFor(() => expect(kinds()).toEqual(["waiting (early)", "waiting"]));
    expect(events[1].ask).toBe("Skal jeg køre den?");
    source.stop();
  });

  it("splits bytes into whole lines and keeps the rest for the next read", () => {
    const bytes = Buffer.from(`${titleLine("Kø")}\n${titleLine("Næste")}`, "utf8");
    const cut = bytes.indexOf(Buffer.from("ø", "utf8")) + 1;
    const first = splitLines(bytes.subarray(0, cut));
    expect(first.lines).toEqual([]);
    const second = splitLines(Buffer.concat([first.rest, bytes.subarray(cut)]));
    expect(second.lines).toEqual([titleLine("Kø")]);
    expect(second.rest.toString("utf8")).toBe(titleLine("Næste"));
  });

  it("reads a transcript again from its start after it was rewritten shorter", async () => {
    const now = Date.now();
    fs.writeFileSync(
      file,
      lines(
        userLine("a long first message that makes this version of the file the longer one", now),
        wrapUpLine({ recap: "R", ask: "First?" }, now),
        assistantText("x", now),
        stopHookLine(now)
      )
    );
    const source = newSource();
    await source.start();
    await source.readFile(file);
    await vi.waitFor(() => expect(kinds()).toEqual(["answered", "waiting (early)", "waiting"]));
    fs.writeFileSync(
      file,
      lines(
        wrapUpLine({ recap: "R", ask: "Second?" }, now + 1),
        assistantText("y", now + 1),
        stopHookLine(now + 1)
      )
    );
    await source.readFile(file);
    await vi.waitFor(() =>
      expect(kinds()).toEqual([
        "answered",
        "waiting (early)",
        "waiting",
        "waiting (early)",
        "waiting",
      ])
    );
    expect(events[4].ask).toBe("Second?");
    source.stop();
  });

  it("ignores headless runs such as its own rewriter and old turns in a copied chat", async () => {
    const source = newSource();
    await source.start();
    const now = Date.now();
    fs.writeFileSync(
      file,
      lines(assistantText("x", now, "end_turn", { entrypoint: "sdk-cli" }), stopHookLine(now))
    );
    await source.readFile(file);
    const old = path.join(root, "C--work-example-repo", "other.jsonl");
    fs.writeFileSync(
      old,
      lines(assistantText("old", now - 3_600_000), stopHookLine(now - 3_600_000))
    );
    await source.readFile(old);
    await settle();
    source.stop();
    expect(events).toEqual([]);
  });
});
