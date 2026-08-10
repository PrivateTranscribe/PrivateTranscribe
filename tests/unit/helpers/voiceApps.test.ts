import { describe, expect, test } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  findActiveVoiceApps,
  matchVoiceApp,
  parseMicWatchLine,
} = require("../../../src/helpers/voiceApps");

describe("matchVoiceApp", () => {
  test("matches the executable base name case-insensitively", () => {
    expect(matchVoiceApp("Discord")?.id).toBe("discord");
    expect(matchVoiceApp("discord")?.id).toBe("discord");
    expect(matchVoiceApp("Discord.exe")?.id).toBe("discord");
  });

  test("does not match unrelated processes that hold the microphone", () => {
    // A real capture endpoint carries sessions from all sorts of things.
    // Matching any of these would mute the user for no reason.
    expect(matchVoiceApp("nvcontainer")).toBeNull();
    expect(matchVoiceApp("chrome")).toBeNull();
    expect(matchVoiceApp("PrivateTranscribe")).toBeNull();
    expect(matchVoiceApp("")).toBeNull();
    expect(matchVoiceApp(undefined)).toBeNull();
  });
});

describe("findActiveVoiceApps", () => {
  test("ignores sessions that exist but are not streaming", () => {
    // An app keeps a capture session after it has finished using the mic, so
    // presence alone must never be read as "in a call".
    expect(
      findActiveVoiceApps([
        { pid: 1, name: "Discord", active: false },
        { pid: 2, name: "zoom", active: false },
      ])
    ).toEqual([]);
  });

  test("returns only known voice apps that are streaming", () => {
    const result = findActiveVoiceApps([
      { pid: 10, name: "chrome", active: false },
      { pid: 11, name: "nvcontainer", active: true },
      { pid: 12, name: "Discord", active: true },
      { pid: 13, name: "PrivateTranscribe", active: false },
    ]);

    expect(result).toEqual([{ id: "discord", label: "Discord", pid: 12, pushToMute: true }]);
  });

  test("collapses several sessions from the same app", () => {
    const result = findActiveVoiceApps([
      { pid: 12, name: "Discord", active: true },
      { pid: 12, name: "Discord", active: true },
    ]);
    expect(result).toHaveLength(1);
  });

  test("survives junk input", () => {
    expect(findActiveVoiceApps(null)).toEqual([]);
    expect(findActiveVoiceApps([null, undefined, {}])).toEqual([]);
  });
});

describe("parseMicWatchLine", () => {
  test("parses a helper line", () => {
    expect(
      parseMicWatchLine('{"sessions":[{"pid":27180,"name":"Discord","active":true}]}')
    ).toEqual([{ pid: 27180, name: "Discord", active: true }]);
  });

  test("drops the pid 0 idle session the enumerator reports", () => {
    expect(parseMicWatchLine('{"sessions":[{"pid":0,"name":"Idle","active":false}]}')).toEqual([]);
  });

  test("returns null rather than an empty list for unreadable output", () => {
    // Returning [] would look like "everyone left the call" and could trigger
    // an unmute. Null means "no new information", so the last state stands.
    expect(parseMicWatchLine("not json")).toBeNull();
    expect(parseMicWatchLine("")).toBeNull();
    expect(parseMicWatchLine('{"unexpected":true}')).toBeNull();
  });
});
