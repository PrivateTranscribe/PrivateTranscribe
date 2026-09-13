import path from "node:path";
import { describe, expect, test } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  assertWindowsFastPasteSucceeded,
  FAST_PASTE_EXECUTABLE,
  getWindowsFastPasteExecutablePaths,
  getWindowsPasteShortcut,
  parseWindowsFastPasteOutput,
  resolveWindowsFastPasteExecutable,
} = require("../../../src/helpers/windowsPasteTarget");

describe("getWindowsPasteShortcut", () => {
  test("uses Ctrl+Shift+V for terminal targets", () => {
    expect(getWindowsPasteShortcut({ isTerminal: true })).toEqual({
      isTerminal: true,
      nircmdKeys: "ctrl+shift+v",
      sendKeys: "^+v",
    });
  });

  test("uses Ctrl+V for ordinary targets", () => {
    expect(getWindowsPasteShortcut({ isTerminal: false })).toEqual({
      isTerminal: false,
      nircmdKeys: "ctrl+v",
      sendKeys: "^v",
    });
  });

  test("defaults to Ctrl+V when no target information is available", () => {
    expect(getWindowsPasteShortcut()).toEqual({
      isTerminal: false,
      nircmdKeys: "ctrl+v",
      sendKeys: "^v",
    });
  });
});

describe("getWindowsFastPasteExecutablePaths", () => {
  test("prefers the packaged resources directory", () => {
    const paths = getWindowsFastPasteExecutablePaths({
      resourcesPath: path.join("C:", "app", "resources"),
      cwd: path.join("C:", "project"),
      helpersDir: path.join("C:", "project", "src", "helpers"),
    });

    expect(paths[0]).toBe(
      path.resolve(path.join("C:", "app", "resources", "bin", FAST_PASTE_EXECUTABLE))
    );
  });

  test("includes the development layout when not packaged", () => {
    const paths = getWindowsFastPasteExecutablePaths({
      resourcesPath: undefined,
      cwd: path.join("C:", "project"),
      helpersDir: path.join("C:", "project", "src", "helpers"),
    });

    expect(paths).toContain(
      path.resolve(path.join("C:", "project", "resources", "bin", FAST_PASTE_EXECUTABLE))
    );
  });

  test("does not repeat identical candidates", () => {
    const paths = getWindowsFastPasteExecutablePaths({
      resourcesPath: undefined,
      cwd: path.join("C:", "project"),
      helpersDir: path.join("C:", "project", "src", "helpers"),
    });

    expect(new Set(paths).size).toBe(paths.length);
  });
});

describe("resolveWindowsFastPasteExecutable", () => {
  const pathOptions = {
    resourcesPath: path.join("C:", "app", "resources"),
    cwd: path.join("C:", "project"),
    helpersDir: path.join("C:", "project", "src", "helpers"),
  };

  test("returns the first candidate that exists", () => {
    const packaged = path.resolve(
      path.join("C:", "app", "resources", "bin", FAST_PASTE_EXECUTABLE)
    );

    expect(
      resolveWindowsFastPasteExecutable({
        ...pathOptions,
        existsSync: (candidate: string) => candidate === packaged,
      })
    ).toBe(packaged);
  });

  test("falls through to a later candidate when the packaged one is missing", () => {
    const development = path.resolve(
      path.join("C:", "project", "resources", "bin", FAST_PASTE_EXECUTABLE)
    );

    expect(
      resolveWindowsFastPasteExecutable({
        ...pathOptions,
        existsSync: (candidate: string) => candidate === development,
      })
    ).toBe(development);
  });

  test("returns null when no candidate exists", () => {
    expect(
      resolveWindowsFastPasteExecutable({ ...pathOptions, existsSync: () => false })
    ).toBeNull();
  });

  test("treats a throwing existence check as missing", () => {
    expect(
      resolveWindowsFastPasteExecutable({
        ...pathOptions,
        existsSync: () => {
          throw new Error("EPERM");
        },
      })
    ).toBeNull();
  });
});

describe("parseWindowsFastPasteOutput", () => {
  test("reads a successful terminal paste", () => {
    const output = JSON.stringify({
      pasted: true,
      dispatched: true,
      isTerminal: true,
      windowClass: "CASCADIA_HOSTING_WINDOW_CLASS",
      processName: "WindowsTerminal",
      chord: "ctrl+shift+v",
    });

    expect(parseWindowsFastPasteOutput(output)).toEqual({
      pasted: true,
      evidence: "absent",
      dispatched: true,
      enterSent: false,
      isTerminal: true,
      windowClass: "CASCADIA_HOSTING_WINDOW_CLASS",
      processName: "WindowsTerminal",
      targetChanged: false,
      heldModifierCount: null,
    });
  });

  // Agent Mode's spoken "send": the helper reports whether it pressed Enter,
  // and a helper built before the field existed reads as "did not".
  test("reads whether Enter was pressed after the paste", () => {
    expect(
      parseWindowsFastPasteOutput(
        JSON.stringify({ pasted: true, evidence: "inserted", sendEnter: true, enterSent: true })
      ).enterSent
    ).toBe(true);
    expect(
      parseWindowsFastPasteOutput(
        JSON.stringify({ pasted: false, evidence: "absent", sendEnter: true, enterSent: false })
      ).enterSent
    ).toBe(false);
    expect(parseWindowsFastPasteOutput(JSON.stringify({ pasted: true })).enterSent).toBe(false);
    expect(parseWindowsFastPasteOutput('{"enterSent":"true"}').enterSent).toBe(false);
  });

  test("carries enterSent onto the not-confirmed error for unobservable targets", () => {
    try {
      assertWindowsFastPasteSucceeded(
        JSON.stringify({ pasted: false, evidence: "none", dispatched: true, enterSent: true })
      );
      throw new Error("expected the helper output to be rejected");
    } catch (error) {
      expect((error as { enterSent?: boolean }).enterSent).toBe(true);
    }
  });

  test("reads a successful ordinary paste", () => {
    const output = JSON.stringify({
      pasted: true,
      isTerminal: false,
      windowClass: "Notepad",
      processName: "notepad",
      chord: "ctrl+v",
    });

    expect(parseWindowsFastPasteOutput(output).isTerminal).toBe(false);
  });

  test("distinguishes a dispatched shortcut from confirmed insertion", () => {
    const parsed = parseWindowsFastPasteOutput(
      JSON.stringify({
        pasted: false,
        dispatched: true,
        isTerminal: false,
        windowClass: "Chrome_WidgetWin_1",
        processName: "Code",
      })
    );

    expect(parsed).toMatchObject({ pasted: false, dispatched: true });
    expect(() =>
      assertWindowsFastPasteSucceeded(
        JSON.stringify({ pasted: false, dispatched: true, isTerminal: false })
      )
    ).toThrow("did not confirm text insertion");
  });

  // The app stays quiet about a paste only when the helper explicitly says it
  // could not read the target. An older helper predates the field entirely, and
  // must not be read as "nothing to worry about".
  test("keeps an unreadable target apart from a field it watched", () => {
    const readNothing = parseWindowsFastPasteOutput(
      JSON.stringify({ pasted: false, evidence: "none", dispatched: true, isTerminal: false })
    );
    expect(readNothing.evidence).toBe("none");

    const watchedIt = parseWindowsFastPasteOutput(
      JSON.stringify({ pasted: false, evidence: "absent", dispatched: true, isTerminal: false })
    );
    expect(watchedIt.evidence).toBe("absent");

    const olderHelper = parseWindowsFastPasteOutput(
      JSON.stringify({ pasted: false, dispatched: true, isTerminal: false })
    );
    expect(olderHelper.evidence).toBe("absent");
  });

  test("carries the evidence onto the thrown not-confirmed error", () => {
    expect(() =>
      assertWindowsFastPasteSucceeded(
        JSON.stringify({ pasted: false, evidence: "none", dispatched: true, isTerminal: false })
      )
    ).toThrow("did not confirm text insertion");

    try {
      assertWindowsFastPasteSucceeded(
        JSON.stringify({ pasted: false, evidence: "none", dispatched: true, isTerminal: false })
      );
    } catch (error) {
      expect((error as { evidence?: string }).evidence).toBe("none");
    }
  });

  test("degrades to a non-terminal result on unreadable output", () => {
    expect(parseWindowsFastPasteOutput("not json")).toEqual({
      pasted: false,
      evidence: "absent",
      dispatched: false,
      enterSent: false,
      isTerminal: false,
      windowClass: "",
      processName: "",
    });
  });

  test("degrades on empty output", () => {
    expect(parseWindowsFastPasteOutput("").isTerminal).toBe(false);
  });

  test("only treats a literal true as terminal", () => {
    expect(parseWindowsFastPasteOutput('{"isTerminal":"true"}').isTerminal).toBe(false);
    expect(parseWindowsFastPasteOutput('{"isTerminal":1}').isTerminal).toBe(false);
  });

  test("caps oversized metadata strings", () => {
    const output = JSON.stringify({
      pasted: true,
      isTerminal: false,
      windowClass: "c".repeat(500),
      processName: "p".repeat(500),
    });
    const parsed = parseWindowsFastPasteOutput(output);

    expect(parsed.windowClass).toHaveLength(128);
    expect(parsed.processName).toHaveLength(128);
  });

  test("ignores non-string metadata", () => {
    const parsed = parseWindowsFastPasteOutput('{"windowClass":42,"processName":null}');

    expect(parsed.windowClass).toBe("");
    expect(parsed.processName).toBe("");
  });
});

describe("assertWindowsFastPasteSucceeded", () => {
  test("rejects a zero-exit helper response that says no paste occurred", () => {
    expect(() =>
      assertWindowsFastPasteSucceeded(
        JSON.stringify({
          pasted: false,
          isTerminal: false,
          windowClass: "Chrome_WidgetWin_1",
          processName: "Code.exe",
        })
      )
    ).toThrow("did not confirm text insertion");
  });
});
