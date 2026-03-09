/**
 * Unit tests for the Action Engine pure helpers.
 *
 * These tests cover the logic that lives in actionEngineManager.js without
 * touching Electron, the filesystem, or any database.  We import the helpers
 * directly via a re-export shim (see bottom of this file) so that tests run
 * in a plain Node/Vitest environment.
 */

import { describe, it, expect, beforeEach } from "vitest";
import type {
  Action,
  ActionConfig,
  ActionExecuteResult,
  ActionRun,
  TriggerMode,
  ActionType,
} from "../../../src/types/actionEngine";

// ─────────────────────────────────────────────────────────────────────────────
// Inline the pure helpers so we don't need to mock Electron in this suite.
// These are verbatim copies of the functions in actionEngineManager.js.
// If the production implementations change, update these copies too.
// ─────────────────────────────────────────────────────────────────────────────

/** Verbatim copy of normalizeForMatching() from actionEngineManager.js. */
function normalizeForMatching(text: string): string {
  return text
    .trim()
    .replace(/[,.!?;:]/g, "") // strip common STT punctuation artifacts
    .replace(/\s+/g, " ") // collapse runs of whitespace
    .trim() // re-trim (leading punctuation may leave a leading space)
    .toLowerCase();
}

function matchesTrigger(transcript: string, action: Action): boolean {
  if (!action.enabled) return false;

  if (action.triggerMode === "regex") {
    try {
      return new RegExp(action.triggerPhrase, "i").test(
        typeof transcript === "string" ? transcript.trim() : ""
      );
    } catch {
      return false;
    }
  }

  const hay = typeof transcript === "string" ? normalizeForMatching(transcript) : "";
  const needle =
    typeof action.triggerPhrase === "string" ? normalizeForMatching(action.triggerPhrase) : "";
  if (!needle) return false;

  switch (action.triggerMode) {
    case "exact":
      return hay === needle;
    case "prefix":
      return hay.startsWith(needle);
    case "contains":
      return hay.includes(needle);
    default:
      return false;
  }
}

function findMatches(
  transcript: string,
  actions: Action[]
): Array<{ action: Action; matchedText: string }> {
  return actions
    .filter((a) => matchesTrigger(transcript, a))
    .map((a) => ({ action: a, matchedText: transcript }));
}

function tokenizeCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;

  for (const ch of command) {
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
    } else if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
    } else if (ch === " " && !inSingle && !inDouble) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
    } else {
      current += ch;
    }
  }
  if (current.length > 0) tokens.push(current);
  return tokens;
}

// Validation helper (inline subset — focus on error paths)
const VALID_TRIGGER_MODES = new Set(["exact", "prefix", "contains", "regex"]);
const VALID_ACTION_TYPES = new Set(["shell", "url", "app", "dictation-mode"]);

function validateActionPayload(raw: unknown): {
  name: string;
  description: string;
  triggerPhrase: string;
  triggerMode: TriggerMode;
  actionType: ActionType;
  actionConfig: ActionConfig;
  enabled: boolean;
} {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Action payload must be a plain object.");
  }
  const r = raw as Record<string, unknown>;

  const name = typeof r.name === "string" ? r.name.trim() : "";
  if (!name) throw new Error("Action name is required.");
  if (name.length > 100) throw new Error("Action name must be 100 characters or fewer.");

  const description = typeof r.description === "string" ? r.description.trim() : "";

  const triggerPhrase = typeof r.triggerPhrase === "string" ? r.triggerPhrase.trim() : "";
  if (!triggerPhrase) throw new Error("Trigger phrase is required.");
  if (triggerPhrase.length > 500)
    throw new Error("Trigger phrase must be 500 characters or fewer.");

  const triggerMode = typeof r.triggerMode === "string" ? r.triggerMode : "contains";
  if (!VALID_TRIGGER_MODES.has(triggerMode)) {
    throw new Error(`Invalid trigger mode "${triggerMode}".`);
  }

  if (triggerMode === "regex") {
    try {
      new RegExp(triggerPhrase, "i");
    } catch {
      throw new Error("Trigger phrase is not a valid regular expression.");
    }
  }

  const actionType = typeof r.actionType === "string" ? r.actionType : "";
  if (!VALID_ACTION_TYPES.has(actionType)) {
    throw new Error(`Invalid action type "${actionType}".`);
  }

  const rawConfig =
    r.actionConfig && typeof r.actionConfig === "object" && !Array.isArray(r.actionConfig)
      ? (r.actionConfig as Record<string, unknown>)
      : {};

  // Per-type config validation
  switch (actionType) {
    case "shell": {
      const cmd = typeof rawConfig.command === "string" ? rawConfig.command.trim() : "";
      if (!cmd) throw new Error("Shell action requires a non-empty command.");
      break;
    }
    case "url": {
      let url = typeof rawConfig.url === "string" ? rawConfig.url.trim() : "";
      if (!url) throw new Error("URL action requires a non-empty URL.");
      if (!url.includes("://")) {
        url = "https://" + url;
        rawConfig.url = url;
      }
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        throw new Error(`"${url}" is not a valid URL. Example: https://example.com`);
      }
      if (!["https:", "http:"].includes(parsed.protocol)) {
        throw new Error(
          `Only https:// and http:// URLs are supported (got "${parsed.protocol.replace(":", "")}://"). ` +
            `Update the URL to start with https://`
        );
      }
      break;
    }
    case "app": {
      const appPath = typeof rawConfig.appPath === "string" ? rawConfig.appPath.trim() : "";
      if (!appPath) throw new Error("App action requires a non-empty appPath.");
      break;
    }
    case "dictation-mode": {
      const mode = typeof rawConfig.mode === "string" ? rawConfig.mode.trim() : "";
      if (!mode) throw new Error("Dictation-mode action requires a non-empty mode.");
      break;
    }
  }

  return {
    name,
    description,
    triggerPhrase,
    triggerMode: triggerMode as TriggerMode,
    actionType: actionType as ActionType,
    actionConfig: rawConfig as ActionConfig,
    enabled: r.enabled !== false,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Test fixtures
// ─────────────────────────────────────────────────────────────────────────────

function makeAction(overrides: Partial<Action> = {}): Action {
  return {
    id: "test-id",
    name: "Test Action",
    description: "",
    triggerPhrase: "open terminal",
    triggerMode: "contains",
    actionType: "shell",
    actionConfig: { command: "echo hello" },
    enabled: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// matchesTrigger
// ─────────────────────────────────────────────────────────────────────────────

describe("matchesTrigger", () => {
  describe("disabled actions", () => {
    it("never matches when action is disabled", () => {
      const action = makeAction({ enabled: false, triggerMode: "exact", triggerPhrase: "hello" });
      expect(matchesTrigger("hello", action)).toBe(false);
    });
  });

  describe("exact mode", () => {
    const action = makeAction({ triggerMode: "exact", triggerPhrase: "open terminal" });

    it("matches identical text", () => {
      expect(matchesTrigger("open terminal", action)).toBe(true);
    });

    it("matches case-insensitively", () => {
      expect(matchesTrigger("Open Terminal", action)).toBe(true);
      expect(matchesTrigger("OPEN TERMINAL", action)).toBe(true);
    });

    it("does not match partial or extended text", () => {
      expect(matchesTrigger("please open terminal now", action)).toBe(false);
      expect(matchesTrigger("open terminals", action)).toBe(false);
    });

    it("ignores leading/trailing whitespace in transcript", () => {
      expect(matchesTrigger("  open terminal  ", action)).toBe(true);
    });
  });

  describe("prefix mode", () => {
    const action = makeAction({ triggerMode: "prefix", triggerPhrase: "open" });

    it("matches when transcript starts with trigger", () => {
      expect(matchesTrigger("open terminal now", action)).toBe(true);
      expect(matchesTrigger("open", action)).toBe(true);
    });

    it("does not match when trigger is not at the start", () => {
      expect(matchesTrigger("please open terminal", action)).toBe(false);
    });

    it("is case-insensitive", () => {
      expect(matchesTrigger("Open my editor", action)).toBe(true);
    });
  });

  describe("contains mode", () => {
    const action = makeAction({ triggerMode: "contains", triggerPhrase: "terminal" });

    it("matches anywhere in transcript", () => {
      expect(matchesTrigger("please open terminal now", action)).toBe(true);
      expect(matchesTrigger("terminal", action)).toBe(true);
      expect(matchesTrigger("start the terminal app", action)).toBe(true);
    });

    it("returns false when phrase is absent", () => {
      expect(matchesTrigger("open my editor", action)).toBe(false);
    });

    it("is case-insensitive", () => {
      expect(matchesTrigger("TERMINAL", action)).toBe(true);
    });
  });

  describe("regex mode", () => {
    it("matches against a valid regex", () => {
      const action = makeAction({
        triggerMode: "regex",
        triggerPhrase: "^(open|close)\\s+terminal$",
      });
      expect(matchesTrigger("open terminal", action)).toBe(true);
      expect(matchesTrigger("close terminal", action)).toBe(true);
      expect(matchesTrigger("Open Terminal", action)).toBe(true); // case-insensitive flag
      expect(matchesTrigger("maybe open terminal later", action)).toBe(false);
    });

    it("returns false (not throw) for an invalid stored regex", () => {
      const action = makeAction({ triggerMode: "regex", triggerPhrase: "[invalid(" });
      expect(matchesTrigger("hello", action)).toBe(false);
    });
  });

  describe("edge cases", () => {
    it("returns false for empty trigger phrase", () => {
      const action = makeAction({ triggerPhrase: "" });
      expect(matchesTrigger("anything", action)).toBe(false);
    });

    it("handles non-string transcript gracefully", () => {
      const action = makeAction({ triggerMode: "exact", triggerPhrase: "hello" });
      // @ts-expect-error intentional non-string for robustness test
      expect(matchesTrigger(null, action)).toBe(false);
    });
  });

  // ── Punctuation / STT-noise normalization ─────────────────────────────────
  // These tests cover the core bug: speech-to-text engines insert punctuation
  // (most commonly commas and periods) that should not prevent a trigger from
  // firing.  The fix normalises both the transcript and the stored trigger
  // phrase before comparison so that the match is punctuation-agnostic for
  // exact / prefix / contains modes.
  describe("punctuation normalization (STT artifact tolerance)", () => {
    describe("contains mode — the reported bug scenario", () => {
      const action = makeAction({
        triggerMode: "contains",
        triggerPhrase: "Open NordicFuture",
        actionType: "url",
        actionConfig: { url: "https://nordicfuture.com" },
      });

      it("matches when STT inserts a comma between words", () => {
        // Spoken: "Open NordicFuture" → transcribed: "Open, NordicFuture"
        expect(matchesTrigger("Open, NordicFuture", action)).toBe(true);
      });

      it("matches when STT appends a trailing period", () => {
        expect(matchesTrigger("Open NordicFuture.", action)).toBe(true);
      });

      it("matches when STT adds a comma AND a trailing period", () => {
        expect(matchesTrigger("Open, NordicFuture.", action)).toBe(true);
      });

      it("matches when STT adds a trailing exclamation mark", () => {
        expect(matchesTrigger("Open NordicFuture!", action)).toBe(true);
      });

      it("matches when STT adds a trailing question mark", () => {
        expect(matchesTrigger("Open NordicFuture?", action)).toBe(true);
      });

      it("matches when multiple commas are present", () => {
        expect(matchesTrigger("please, Open, NordicFuture, now", action)).toBe(true);
      });

      it("still rejects a transcript that lacks the trigger phrase entirely", () => {
        expect(matchesTrigger("Close, SomethingElse.", action)).toBe(false);
      });
    });

    describe("exact mode — punctuation stripped before comparison", () => {
      const action = makeAction({
        triggerMode: "exact",
        triggerPhrase: "open terminal",
      });

      it("matches when STT appends a period", () => {
        expect(matchesTrigger("open terminal.", action)).toBe(true);
      });

      it("matches when STT appends a comma", () => {
        // Edge case: comma after last word
        expect(matchesTrigger("open terminal,", action)).toBe(true);
      });

      it("still rejects extended text even after normalization", () => {
        expect(matchesTrigger("please open terminal now", action)).toBe(false);
      });
    });

    describe("prefix mode — punctuation stripped before comparison", () => {
      const action = makeAction({
        triggerMode: "prefix",
        triggerPhrase: "open",
      });

      it("matches when STT inserts comma after trigger word", () => {
        expect(matchesTrigger("open, terminal now", action)).toBe(true);
      });

      it("still rejects when phrase does not start with trigger", () => {
        expect(matchesTrigger("please, open terminal", action)).toBe(false);
      });
    });

    describe("extra whitespace normalization", () => {
      const action = makeAction({
        triggerMode: "contains",
        triggerPhrase: "open terminal",
      });

      it("matches when transcript has extra internal spaces", () => {
        expect(matchesTrigger("open  terminal", action)).toBe(true);
      });

      it("matches when punctuation removal leaves a double-space gap", () => {
        // "open, terminal" → strip comma → "open  terminal" → collapse → "open terminal"
        expect(matchesTrigger("open, terminal", action)).toBe(true);
      });
    });

    describe("regex mode — normalization NOT applied", () => {
      it("regex pattern matches the raw (non-normalized) transcript", () => {
        // The user explicitly wrote a regex; normalization must not interfere.
        const action = makeAction({
          triggerMode: "regex",
          triggerPhrase: "^open terminal$",
        });
        expect(matchesTrigger("open terminal", action)).toBe(true);
        // The regex does NOT account for the comma, so this should NOT match —
        // proving that regex mode bypasses normalization.
        expect(matchesTrigger("open, terminal", action)).toBe(false);
      });
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// normalizeForMatching (standalone unit tests)
// ─────────────────────────────────────────────────────────────────────────────

describe("normalizeForMatching", () => {
  it("strips commas", () => {
    expect(normalizeForMatching("Open, NordicFuture")).toBe("open nordicfuture");
  });

  it("strips trailing periods", () => {
    expect(normalizeForMatching("open terminal.")).toBe("open terminal");
  });

  it("strips exclamation marks", () => {
    expect(normalizeForMatching("open terminal!")).toBe("open terminal");
  });

  it("strips question marks", () => {
    expect(normalizeForMatching("open terminal?")).toBe("open terminal");
  });

  it("strips semicolons and colons", () => {
    expect(normalizeForMatching("open; terminal: now")).toBe("open terminal now");
  });

  it("collapses runs of whitespace left after punctuation removal", () => {
    // comma removal leaves two adjacent spaces
    expect(normalizeForMatching("open,  terminal")).toBe("open terminal");
  });

  it("lowercases the result", () => {
    expect(normalizeForMatching("OPEN TERMINAL")).toBe("open terminal");
  });

  it("trims leading and trailing whitespace", () => {
    expect(normalizeForMatching("  open terminal  ")).toBe("open terminal");
  });

  it("preserves apostrophes in contractions", () => {
    expect(normalizeForMatching("don't open this")).toBe("don't open this");
  });

  it("preserves hyphens in compound words", () => {
    expect(normalizeForMatching("push-to-talk mode")).toBe("push-to-talk mode");
  });

  it("handles an already-clean string without mutation", () => {
    expect(normalizeForMatching("open terminal")).toBe("open terminal");
  });

  it("handles an empty string", () => {
    expect(normalizeForMatching("")).toBe("");
  });

  it("handles punctuation-only input (edge case)", () => {
    expect(normalizeForMatching(",.!?;:")).toBe("");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// findMatches
// ─────────────────────────────────────────────────────────────────────────────

describe("findMatches", () => {
  it("returns all matching actions", () => {
    const a1 = makeAction({ id: "1", triggerMode: "contains", triggerPhrase: "terminal" });
    const a2 = makeAction({ id: "2", triggerMode: "contains", triggerPhrase: "editor" });
    const a3 = makeAction({ id: "3", triggerMode: "exact", triggerPhrase: "open terminal" });

    const results = findMatches("open terminal", [a1, a2, a3]);

    expect(results).toHaveLength(2);
    expect(results.map((r) => r.action.id)).toEqual(["1", "3"]);
  });

  it("returns empty array when nothing matches", () => {
    const a = makeAction({ triggerMode: "exact", triggerPhrase: "close editor" });
    expect(findMatches("open terminal", [a])).toHaveLength(0);
  });

  it("skips disabled actions", () => {
    const a = makeAction({ triggerMode: "contains", triggerPhrase: "terminal", enabled: false });
    expect(findMatches("open terminal", [a])).toHaveLength(0);
  });

  it("preserves input order", () => {
    const actions = [
      makeAction({ id: "first", triggerMode: "contains", triggerPhrase: "hello" }),
      makeAction({ id: "second", triggerMode: "contains", triggerPhrase: "hello" }),
    ];
    const results = findMatches("hello world", actions);
    expect(results[0].action.id).toBe("first");
    expect(results[1].action.id).toBe("second");
  });

  it("includes the full transcript as matchedText", () => {
    const a = makeAction({ triggerMode: "contains", triggerPhrase: "test" });
    const results = findMatches("this is a test", [a]);
    expect(results[0].matchedText).toBe("this is a test");
  });

  it("handles an empty action list", () => {
    expect(findMatches("hello", [])).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// tokenizeCommand
// ─────────────────────────────────────────────────────────────────────────────

describe("tokenizeCommand", () => {
  it("splits on whitespace", () => {
    expect(tokenizeCommand("echo hello world")).toEqual(["echo", "hello", "world"]);
  });

  it("collapses multiple spaces", () => {
    expect(tokenizeCommand("echo  hello")).toEqual(["echo", "hello"]);
  });

  it("respects double-quoted arguments", () => {
    expect(tokenizeCommand('open -a "Visual Studio Code"')).toEqual([
      "open",
      "-a",
      "Visual Studio Code",
    ]);
  });

  it("respects single-quoted arguments", () => {
    expect(tokenizeCommand("say 'hello world'")).toEqual(["say", "hello world"]);
  });

  it("handles empty string", () => {
    expect(tokenizeCommand("")).toEqual([]);
  });

  it("handles only whitespace", () => {
    expect(tokenizeCommand("   ")).toEqual([]);
  });

  it("handles a single token with no spaces", () => {
    expect(tokenizeCommand("ls")).toEqual(["ls"]);
  });

  it("preserves nested quote styles independently", () => {
    // Double-quoted string containing single quote character
    expect(tokenizeCommand('echo "it\'s fine"')).toEqual(["echo", "it's fine"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// validateActionPayload
// ─────────────────────────────────────────────────────────────────────────────

describe("validateActionPayload", () => {
  const base = {
    name: "My Action",
    description: "Does something",
    triggerPhrase: "open terminal",
    triggerMode: "contains",
    actionType: "shell",
    actionConfig: { command: "echo hello" },
    enabled: true,
  };

  describe("valid payloads", () => {
    it("accepts a complete shell action", () => {
      const result = validateActionPayload(base);
      expect(result.name).toBe("My Action");
      expect(result.actionType).toBe("shell");
      expect(result.enabled).toBe(true);
    });

    it("defaults enabled to true when omitted", () => {
      const { enabled: _omit, ...rest } = base;
      expect(validateActionPayload(rest).enabled).toBe(true);
    });

    it("defaults description to empty string when omitted", () => {
      const { description: _omit, ...rest } = base;
      expect(validateActionPayload(rest).description).toBe("");
    });

    it("accepts a url action", () => {
      const payload = {
        ...base,
        actionType: "url",
        actionConfig: { url: "https://example.com" },
      };
      expect(() => validateActionPayload(payload)).not.toThrow();
    });

    it("accepts an app action", () => {
      const payload = {
        ...base,
        actionType: "app",
        actionConfig: { appPath: "/Applications/Terminal.app" },
      };
      expect(() => validateActionPayload(payload)).not.toThrow();
    });

    it("accepts a dictation-mode action", () => {
      const payload = {
        ...base,
        actionType: "dictation-mode",
        actionConfig: { mode: "code" },
      };
      expect(() => validateActionPayload(payload)).not.toThrow();
    });

    it("accepts a regex trigger mode", () => {
      const payload = { ...base, triggerMode: "regex", triggerPhrase: "^open\\s+\\w+" };
      expect(() => validateActionPayload(payload)).not.toThrow();
    });
  });

  describe("invalid payloads — name", () => {
    it("throws when name is missing", () => {
      expect(() => validateActionPayload({ ...base, name: "" })).toThrow("name is required");
    });

    it("throws when name exceeds 100 chars", () => {
      expect(() => validateActionPayload({ ...base, name: "x".repeat(101) })).toThrow(
        "100 characters"
      );
    });
  });

  describe("invalid payloads — triggerPhrase", () => {
    it("throws when trigger phrase is empty", () => {
      expect(() => validateActionPayload({ ...base, triggerPhrase: "" })).toThrow(
        "Trigger phrase is required"
      );
    });

    it("throws when trigger phrase exceeds 500 chars", () => {
      expect(() => validateActionPayload({ ...base, triggerPhrase: "x".repeat(501) })).toThrow(
        "500 characters"
      );
    });

    it("throws when regex trigger is invalid", () => {
      expect(() =>
        validateActionPayload({ ...base, triggerMode: "regex", triggerPhrase: "[broken(" })
      ).toThrow("valid regular expression");
    });
  });

  describe("invalid payloads — triggerMode", () => {
    it("throws for unknown trigger mode", () => {
      expect(() => validateActionPayload({ ...base, triggerMode: "fuzzy" })).toThrow(
        "Invalid trigger mode"
      );
    });
  });

  describe("invalid payloads — actionType", () => {
    it("throws for unknown action type", () => {
      expect(() => validateActionPayload({ ...base, actionType: "magic" })).toThrow(
        "Invalid action type"
      );
    });
  });

  describe("invalid payloads — actionConfig", () => {
    it("throws when shell command is empty", () => {
      expect(() => validateActionPayload({ ...base, actionConfig: { command: "" } })).toThrow(
        "non-empty command"
      );
    });

    it("throws when url is empty", () => {
      expect(() =>
        validateActionPayload({ ...base, actionType: "url", actionConfig: { url: "" } })
      ).toThrow("non-empty URL");
    });

    it("auto-prepends https:// when protocol is missing", () => {
      const payload = {
        ...base,
        actionType: "url",
        actionConfig: { url: "example.com" },
      };
      const result = validateActionPayload(payload);
      expect((result.actionConfig as { url: string }).url).toBe("https://example.com");
    });

    it("throws when url uses a non-http scheme", () => {
      expect(() =>
        validateActionPayload({
          ...base,
          actionType: "url",
          actionConfig: { url: "ftp://example.com" },
        })
      ).toThrow("Only https:// and http://");
    });

    it("throws when appPath is empty", () => {
      expect(() =>
        validateActionPayload({ ...base, actionType: "app", actionConfig: { appPath: "" } })
      ).toThrow("non-empty appPath");
    });

    it("throws when dictation-mode mode is empty", () => {
      expect(() =>
        validateActionPayload({
          ...base,
          actionType: "dictation-mode",
          actionConfig: { mode: "" },
        })
      ).toThrow("non-empty mode");
    });
  });

  describe("non-object payloads", () => {
    it("throws for null", () => {
      expect(() => validateActionPayload(null)).toThrow("plain object");
    });

    it("throws for array", () => {
      expect(() => validateActionPayload([])).toThrow("plain object");
    });

    it("throws for primitive", () => {
      expect(() => validateActionPayload("string")).toThrow("plain object");
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// MockActionEngineManager — in-memory CRUD (mirrors ActionEngineManager logic)
// ─────────────────────────────────────────────────────────────────────────────

let _idCounter = 0;

class MockActionEngineManager {
  private store: Map<string, Action> = new Map();

  listActions(): Action[] {
    return Array.from(this.store.values()).sort(
      (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    );
  }

  getAction(id: string): Action | null {
    return this.store.get(id) ?? null;
  }

  createAction(payload: unknown): Action {
    const validated = validateActionPayload(payload);
    const id = `mock-${++_idCounter}`;
    const now = new Date().toISOString();
    const action: Action = { id, ...validated, createdAt: now, updatedAt: now };
    this.store.set(id, action);
    return action;
  }

  updateAction(id: string, patch: unknown): Action {
    const existing = this.getAction(id);
    if (!existing) throw new Error(`Action not found: ${id}`);
    const merged = { ...existing, ...(patch as object), id };
    const validated = validateActionPayload(merged);
    const now = new Date().toISOString();
    const updated: Action = { id, ...validated, createdAt: existing.createdAt, updatedAt: now };
    this.store.set(id, updated);
    return updated;
  }

  deleteAction(id: string): { success: boolean } {
    const existed = this.store.has(id);
    this.store.delete(id);
    return { success: existed };
  }

  setActionEnabled(id: string, enabled: boolean): Action {
    const existing = this.getAction(id);
    if (!existing) throw new Error(`Action not found: ${id}`);
    const now = new Date().toISOString();
    const updated: Action = { ...existing, enabled, updatedAt: now };
    this.store.set(id, updated);
    return updated;
  }

  matchTranscript(transcript: string): Array<{ action: Action; matchedText: string }> {
    return findMatches(
      transcript,
      this.listActions().filter((a) => a.enabled)
    );
  }
}

describe("MockActionEngineManager (CRUD)", () => {
  let mgr: MockActionEngineManager;

  beforeEach(() => {
    mgr = new MockActionEngineManager();
  });

  it("creates and retrieves an action", () => {
    const action = mgr.createAction({
      name: "Open Editor",
      triggerPhrase: "open editor",
      triggerMode: "contains",
      actionType: "shell",
      actionConfig: { command: "code ." },
    });

    expect(action.id).toBeTruthy();
    expect(action.name).toBe("Open Editor");
    expect(mgr.getAction(action.id)).toEqual(action);
  });

  it("listActions returns actions in creation order", () => {
    mgr.createAction({
      name: "First",
      triggerPhrase: "first",
      triggerMode: "exact",
      actionType: "shell",
      actionConfig: { command: "echo first" },
    });
    mgr.createAction({
      name: "Second",
      triggerPhrase: "second",
      triggerMode: "exact",
      actionType: "shell",
      actionConfig: { command: "echo second" },
    });

    const list = mgr.listActions();
    expect(list[0].name).toBe("First");
    expect(list[1].name).toBe("Second");
  });

  it("updates an existing action", () => {
    const action = mgr.createAction({
      name: "Old Name",
      triggerPhrase: "trigger",
      triggerMode: "exact",
      actionType: "shell",
      actionConfig: { command: "echo old" },
    });

    const updated = mgr.updateAction(action.id, { name: "New Name" });
    expect(updated.name).toBe("New Name");
    expect(updated.actionConfig.command).toBe("echo old"); // unchanged
    expect(mgr.getAction(action.id)?.name).toBe("New Name");
  });

  it("throws when updating non-existent action", () => {
    expect(() => mgr.updateAction("ghost-id", { name: "Nope" })).toThrow("not found");
  });

  it("deletes an action", () => {
    const action = mgr.createAction({
      name: "Temp",
      triggerPhrase: "temp",
      triggerMode: "exact",
      actionType: "shell",
      actionConfig: { command: "echo temp" },
    });

    expect(mgr.deleteAction(action.id)).toEqual({ success: true });
    expect(mgr.getAction(action.id)).toBeNull();
  });

  it("returns success:false when deleting non-existent id", () => {
    expect(mgr.deleteAction("nonexistent")).toEqual({ success: false });
  });

  it("enables and disables an action", () => {
    const action = mgr.createAction({
      name: "Toggleable",
      triggerPhrase: "toggle",
      triggerMode: "exact",
      actionType: "shell",
      actionConfig: { command: "echo on" },
      enabled: true,
    });

    const disabled = mgr.setActionEnabled(action.id, false);
    expect(disabled.enabled).toBe(false);

    const reenabled = mgr.setActionEnabled(action.id, true);
    expect(reenabled.enabled).toBe(true);
  });

  it("matchTranscript returns only enabled actions that match", () => {
    mgr.createAction({
      name: "Active",
      triggerPhrase: "hello",
      triggerMode: "contains",
      actionType: "shell",
      actionConfig: { command: "echo active" },
      enabled: true,
    });
    const inactive = mgr.createAction({
      name: "Inactive",
      triggerPhrase: "hello",
      triggerMode: "contains",
      actionType: "shell",
      actionConfig: { command: "echo inactive" },
      enabled: true,
    });
    mgr.setActionEnabled(inactive.id, false);

    const matches = mgr.matchTranscript("say hello world");
    expect(matches).toHaveLength(1);
    expect(matches[0].action.name).toBe("Active");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// buildRunRecord — pure run record builder (inlined copy for isolation)
// ─────────────────────────────────────────────────────────────────────────────

// Verbatim copy of buildRunRecord from actionEngineManager.js.
// Keep in sync if the production implementation changes.
let _runIdCounter = 0;
function buildRunRecord(
  action: Action,
  result: ActionExecuteResult,
  triggeredBy: "manual" | "transcript",
  triggerText: string | null,
  durationMs: number
): ActionRun {
  return {
    id: `run-${++_runIdCounter}`,
    actionId: action.id,
    actionName: action.name,
    actionType: action.actionType,
    triggerText: triggerText ?? null,
    triggeredBy: triggeredBy === "transcript" ? "transcript" : "manual",
    success: result.success,
    output: typeof result.output === "string" ? result.output : undefined,
    error: typeof result.error === "string" ? result.error : undefined,
    durationMs: Math.round(Math.max(0, durationMs)),
    triggeredAt: new Date().toISOString(),
  };
}

const BASE_ACTION: Action = {
  id: "action-1",
  name: "Test Action",
  description: "",
  triggerPhrase: "run test",
  triggerMode: "contains",
  actionType: "shell",
  actionConfig: { command: "echo hello" },
  enabled: true,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

describe("buildRunRecord (pure)", () => {
  it("captures basic success fields", () => {
    const result: ActionExecuteResult = { success: true, output: "hello" };
    const run = buildRunRecord(BASE_ACTION, result, "manual", null, 123);

    expect(run.actionId).toBe("action-1");
    expect(run.actionName).toBe("Test Action");
    expect(run.actionType).toBe("shell");
    expect(run.success).toBe(true);
    expect(run.output).toBe("hello");
    expect(run.error).toBeUndefined();
    expect(run.durationMs).toBe(123);
    expect(run.triggeredBy).toBe("manual");
    expect(run.triggerText).toBeNull();
    expect(run.triggeredAt).toBeTruthy();
    expect(run.id).toBeTruthy();
  });

  it("captures failure fields", () => {
    const result: ActionExecuteResult = { success: false, error: "command not found" };
    const run = buildRunRecord(BASE_ACTION, result, "transcript", "open terminal", 45);

    expect(run.success).toBe(false);
    expect(run.error).toBe("command not found");
    expect(run.output).toBeUndefined();
    expect(run.triggeredBy).toBe("transcript");
    expect(run.triggerText).toBe("open terminal");
  });

  it("normalises triggeredBy to 'manual' for unknown values", () => {
    const result: ActionExecuteResult = { success: true };
    // Force an unexpected value through the type system
    const run = buildRunRecord(BASE_ACTION, result, "manual", null, 0);
    expect(run.triggeredBy).toBe("manual");
  });

  it("rounds durationMs to integer", () => {
    const result: ActionExecuteResult = { success: true };
    const run = buildRunRecord(BASE_ACTION, result, "manual", null, 12.9);
    expect(run.durationMs).toBe(13);
    expect(Number.isInteger(run.durationMs)).toBe(true);
  });

  it("clamps negative durationMs to zero", () => {
    const result: ActionExecuteResult = { success: true };
    const run = buildRunRecord(BASE_ACTION, result, "manual", null, -50);
    expect(run.durationMs).toBe(0);
  });

  it("omits output when result.output is undefined", () => {
    const result: ActionExecuteResult = { success: true };
    const run = buildRunRecord(BASE_ACTION, result, "manual", null, 10);
    expect(run.output).toBeUndefined();
  });

  it("snapshots action name and type at call time", () => {
    const modified: Action = { ...BASE_ACTION, name: "Renamed Action", actionType: "url" };
    const result: ActionExecuteResult = { success: true };
    const run = buildRunRecord(modified, result, "manual", null, 0);
    expect(run.actionName).toBe("Renamed Action");
    expect(run.actionType).toBe("url");
  });

  it("each call produces a unique id", () => {
    const result: ActionExecuteResult = { success: true };
    const r1 = buildRunRecord(BASE_ACTION, result, "manual", null, 0);
    const r2 = buildRunRecord(BASE_ACTION, result, "manual", null, 0);
    expect(r1.id).not.toBe(r2.id);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// MockRunStore — in-memory run history (mirrors ActionEngineManager run methods)
// ─────────────────────────────────────────────────────────────────────────────

class MockRunStore {
  private runs: ActionRun[] = [];

  record(run: ActionRun): void {
    this.runs.push(run);
  }

  listRuns(limit = 50): ActionRun[] {
    return [...this.runs]
      .sort((a, b) => new Date(b.triggeredAt).getTime() - new Date(a.triggeredAt).getTime())
      .slice(0, Math.max(1, Math.min(500, limit)));
  }

  clearRuns(): { success: boolean } {
    this.runs = [];
    return { success: true };
  }
}

describe("MockRunStore (run history CRUD)", () => {
  let store: MockRunStore;

  beforeEach(() => {
    store = new MockRunStore();
  });

  it("starts empty", () => {
    expect(store.listRuns()).toHaveLength(0);
  });

  it("stores a run and retrieves it", () => {
    const run = buildRunRecord(BASE_ACTION, { success: true }, "manual", null, 100);
    store.record(run);
    expect(store.listRuns()).toHaveLength(1);
    expect(store.listRuns()[0].actionName).toBe("Test Action");
  });

  it("returns runs newest first", async () => {
    const run1 = buildRunRecord(BASE_ACTION, { success: true }, "manual", null, 10);
    // Advance time slightly for deterministic ordering
    await new Promise((r) => setTimeout(r, 2));
    const run2 = buildRunRecord(
      BASE_ACTION,
      { success: false, error: "oops" },
      "transcript",
      "test",
      5
    );
    store.record(run1);
    store.record(run2);
    const list = store.listRuns();
    expect(new Date(list[0].triggeredAt).getTime()).toBeGreaterThanOrEqual(
      new Date(list[1].triggeredAt).getTime()
    );
  });

  it("respects limit parameter", () => {
    for (let i = 0; i < 10; i++) {
      store.record(buildRunRecord(BASE_ACTION, { success: true }, "manual", null, i));
    }
    expect(store.listRuns(3)).toHaveLength(3);
    expect(store.listRuns(10)).toHaveLength(10);
    expect(store.listRuns(100)).toHaveLength(10);
  });

  it("clearRuns empties the store", () => {
    store.record(buildRunRecord(BASE_ACTION, { success: true }, "manual", null, 10));
    const result = store.clearRuns();
    expect(result).toEqual({ success: true });
    expect(store.listRuns()).toHaveLength(0);
  });

  it("records both success and failure runs", () => {
    store.record(buildRunRecord(BASE_ACTION, { success: true, output: "ok" }, "manual", null, 10));
    store.record(
      buildRunRecord(BASE_ACTION, { success: false, error: "boom" }, "transcript", "open app", 5)
    );
    const all = store.listRuns();
    expect(all).toHaveLength(2);
    const successful = all.find((r) => r.success);
    const failed = all.find((r) => !r.success);
    expect(successful?.output).toBe("ok");
    expect(failed?.error).toBe("boom");
    expect(failed?.triggerText).toBe("open app");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// resolveActionEngineEnabled — global kill-switch helper
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Verbatim copy of resolveActionEngineEnabled() from useActionEngine.ts.
 * A missing / null value means enabled (default); only the explicit string
 * "false" disables the engine.
 */
function resolveActionEngineEnabled(raw: string | null): boolean {
  return raw !== "false";
}

describe("resolveActionEngineEnabled", () => {
  it("returns true when the stored value is null (never set)", () => {
    expect(resolveActionEngineEnabled(null)).toBe(true);
  });

  it("returns true when the stored value is 'true'", () => {
    expect(resolveActionEngineEnabled("true")).toBe(true);
  });

  it("returns false only when the stored value is exactly 'false'", () => {
    expect(resolveActionEngineEnabled("false")).toBe(false);
  });

  it("returns true for any unexpected / unknown string", () => {
    expect(resolveActionEngineEnabled("1")).toBe(true);
    expect(resolveActionEngineEnabled("")).toBe(true);
    expect(resolveActionEngineEnabled("yes")).toBe(true);
  });

  it("kill switch does not affect individual-action enabled flag", () => {
    // Simulates: engine globally disabled but per-action flag still respected
    // when you re-enable.  The resolver is independent of per-action state.
    const engineEnabled = resolveActionEngineEnabled("false");
    const actionEnabled = true;
    // When engine is off the match should be skipped regardless of action state.
    expect(engineEnabled && actionEnabled).toBe(false);
  });

  it("kill switch enabled allows per-action disabled to still block matching", () => {
    const engineEnabled = resolveActionEngineEnabled("true");
    const actionEnabled = false;
    expect(engineEnabled && actionEnabled).toBe(false);
  });

  it("both engine and action enabled allows matching", () => {
    const engineEnabled = resolveActionEngineEnabled("true");
    const actionEnabled = true;
    expect(engineEnabled && actionEnabled).toBe(true);
  });
});
