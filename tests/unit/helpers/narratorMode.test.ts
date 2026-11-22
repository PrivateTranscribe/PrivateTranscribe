import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SESSION, assistantText, skillLine, slashCommandLine, userLine } from "./narratorFixtures";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  NarratorModes,
  narratorChange,
  isNarratorSkill,
} = require("../../../src/helpers/narrator/narratorMode");

const T = Date.parse("2026-11-05T20:00:00Z");
const parse = (line: string) => JSON.parse(line);

describe("narrator mode of one transcript line", () => {
  it("knows a narrator skill by its name, with or without a plugin prefix", () => {
    for (const name of ["narrator", "team-narrator", "tools:team-narrator", "/team-narrator"]) {
      expect(isNarratorSkill(name)).toBe(true);
    }
    for (const name of ["narrators", "narrator-setup", "writing-style", "", undefined]) {
      expect(isNarratorSkill(name)).toBe(false);
    }
  });

  it("turns on with a load, off with the argument off, and ignores other skills", () => {
    expect(narratorChange(parse(skillLine("team-narrator", T)))).toBe(true);
    expect(narratorChange(parse(skillLine("team-narrator", T, "off")))).toBe(false);
    expect(narratorChange(parse(skillLine("team-narrator", T, " OFF ")))).toBe(false);
    expect(narratorChange(parse(skillLine("team-narrator", T, "louder")))).toBe(true);
    expect(narratorChange(parse(skillLine("writing-style", T)))).toBeNull();
    expect(narratorChange(parse(assistantText("I could load team-narrator.", T)))).toBeNull();
  });

  it("counts a slash command the person typed, and never a subagent's load", () => {
    expect(narratorChange(parse(slashCommandLine("team-narrator", "", T)))).toBe(true);
    expect(narratorChange(parse(slashCommandLine("team-narrator", "off", T)))).toBe(false);
    expect(narratorChange(parse(slashCommandLine("model", "fast", T)))).toBeNull();
    expect(narratorChange(parse(userLine("please run /team-narrator", T)))).toBeNull();
    expect(
      narratorChange(parse(skillLine("team-narrator", T, undefined, { isSidechain: true })))
    ).toBeNull();
  });
});

describe("narrator mode of a chat", () => {
  let root: string;
  let file: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "pt-narrator-mode-"));
    fs.mkdirSync(path.join(root, "C--work-example"));
    file = path.join(root, "C--work-example", `${SESSION}.jsonl`);
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const write = (lines: string[]) => fs.appendFileSync(file, lines.map((l) => `${l}\n`).join(""));

  it("is off until a load, and the latest load wins", async () => {
    const modes = new NarratorModes({ root });
    write([userLine("hi", T), assistantText("Hello.", T + 1)]);
    expect(await modes.modeOf(file)).toBe(false);
    write([skillLine("team-narrator", T + 2)]);
    expect(await modes.modeOf(file)).toBe(true);
    write([skillLine("team-narrator", T + 3, "off")]);
    expect(await modes.modeOf(file)).toBe(false);
    write([slashCommandLine("team-narrator", "", T + 4)]);
    expect(await modes.modeOf(file)).toBe(true);
  });

  it("finds a load far before the tail, past a line longer than one read", async () => {
    const modes = new NarratorModes({ root });
    const filler = assistantText("x".repeat(5 * 1024 * 1024), T + 1, null);
    write([skillLine("team-narrator", T), filler, filler, assistantText("Done.", T + 2)]);
    expect(await modes.modeOf(file)).toBe(true);
  });

  it("reads a line that was half written only once it is whole", async () => {
    const modes = new NarratorModes({ root });
    const line = skillLine("team-narrator", T);
    fs.appendFileSync(file, line.slice(0, 40));
    expect(await modes.modeOf(file)).toBe(false);
    fs.appendFileSync(file, `${line.slice(40)}\n`);
    expect(await modes.modeOf(file)).toBe(true);
  });

  it("finds a chat by its session id, and refuses anything that is not one", async () => {
    const modes = new NarratorModes({ root });
    write([skillLine("team-narrator", T)]);
    expect(await modes.modeOfSession(SESSION)).toBe(true);
    expect(await modes.modeOfSession(SESSION, { cwd: "C:\\work\\example" })).toBe(true);
    expect(await modes.modeOfSession("11111111-2222-4333-8444-000000000000")).toBeNull();
    expect(await modes.modeOfSession("../../etc/passwd")).toBeNull();
    expect(await modes.modeOfSession(null)).toBeNull();
  });
});
