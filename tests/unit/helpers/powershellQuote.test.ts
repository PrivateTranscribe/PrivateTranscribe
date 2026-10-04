import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * PowerShell ends a single-quoted literal at the apostrophe and at four curly
 * quotes. A Windows user folder such as C:\Users\O’Brien used to end the literal
 * early in the ducking scripts, so the rest of the path ran as code.
 */

const { psQuote, withUtf8Bom } = require("../../../src/helpers/powershellQuote");

const QUOTES: Array<[string, string]> = [
  ["apostrophe U+0027", "'"],
  ["left single quotation mark U+2018", "\u2018"],
  ["right single quotation mark U+2019", "\u2019"],
  ["single low-9 quotation mark U+201A", "\u201A"],
  ["single high-reversed-9 quotation mark U+201B", "\u201B"],
];

describe("psQuote", () => {
  it.each(QUOTES)("doubles the %s", (_name, quote) => {
    expect(psQuote(`O${quote}Brien`)).toBe(`'O${quote}${quote}Brien'`);
  });

  it("doubles every quote in the string, not only the first", () => {
    expect(psQuote("a'b\u2019c'")).toBe("'a''b\u2019\u2019c'''");
  });

  it("only wraps a string that has no quotes in it", () => {
    const plain = "C:\\Users\\Søren Ørsted\\AppData\\Local\\Temp\\state.json";
    expect(psQuote(plain)).toBe(`'${plain}'`);
  });
});

describe("withUtf8Bom", () => {
  // Without the mark Windows PowerShell 5.1 reads the file as ANSI, where the
  // second UTF-8 byte of "Ò" is a curly quote that would end the literal.
  it("starts the script with the UTF-8 byte order mark and leaves the rest alone", () => {
    const bytes = Buffer.from(withUtf8Bom("Write-Output 'Ò'"), "utf8");
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(bytes.subarray(3).toString("utf8")).toBe("Write-Output 'Ò'");
  });
});

describe("the ducking scripts quote paths with it", () => {
  const STATE_PATH = "C:\\Users\\O\u2019Brien\\AppData\\Roaming\\PrivateTranscribe\\state.txt";
  const DIAG_FLAG = "PRIVATETRANSCRIBE_DIAG_DISABLE_AUDIO_DUCKING";
  let savedDiagFlag: string | undefined;

  beforeEach(() => {
    savedDiagFlag = process.env[DIAG_FLAG];
    delete process.env[DIAG_FLAG];
  });

  afterEach(() => {
    if (savedDiagFlag === undefined) delete process.env[DIAG_FLAG];
    else process.env[DIAG_FLAG] = savedDiagFlag;
  });

  it("dictation ducking writes its state file to the whole path", async () => {
    const { buildWindowsDuckScriptLines } =
      (await import("../../../src/helpers/audioDuckingManager.js")) as any;

    const script = buildWindowsDuckScriptLines({
      mode: "duck",
      duckLevel: 0.5,
      statePath: STATE_PATH,
    }).join("\n");

    expect(script).toContain(`WriteAllText(${psQuote(STATE_PATH)},`);
    expect(script).toContain("O\u2019\u2019Brien");
  });

  it("read-aloud ducking hands the whole state path to the script", async () => {
    const mod: any = await import("../../../src/helpers/readAloudDucking.js");
    const ReadAloudDucking = mod.default ?? mod;
    const runPowerShell = vi.fn(async () => "");

    const ducking = new ReadAloudDucking({
      platform: "win32",
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      fs: { existsSync: () => false, readFileSync: vi.fn(), writeFileSync: vi.fn() },
      runPowerShell,
      stateFilePath: STATE_PATH,
      getExcludedPids: () => [4242],
      watchdogMs: 0,
    });

    await ducking.duckOthers();

    expect(runPowerShell).toHaveBeenCalledTimes(1);
    const script = runPowerShell.mock.calls[0][0] as string;
    expect(script).toContain(psQuote(STATE_PATH));
    expect(script).toContain("O\u2019\u2019Brien");
  });
});
