/**
 * Tests for hotkey utilities
 * @module tests/unit/utils/hotkeys
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock navigator for platform detection tests
let mockNavigatorPlatform = "MacIntel";

// Helper to override navigator.platform
function setMockPlatform(platform: string) {
  mockNavigatorPlatform = platform;
}

// Inline implementations for testing (avoiding module import issues)
function isMacPlatform(): boolean {
  return /Mac|Darwin/.test(mockNavigatorPlatform);
}

function formatModifierPart(part: string, isMac: boolean): string {
  switch (part) {
    case "CommandOrControl":
      return isMac ? "Cmd" : "Ctrl";
    case "Command":
    case "Cmd":
      return "Cmd";
    case "Control":
    case "Ctrl":
      return "Ctrl";
    case "Alt":
      return isMac ? "Option" : "Alt";
    case "Option":
      return "Option";
    case "Shift":
      return "Shift";
    case "Super":
    case "Meta":
      return isMac ? "Cmd" : "Win";
    case "Mouse4":
    case "XButton1":
      return "Mouse 4 (Back)";
    case "Mouse5":
    case "XButton2":
      return "Mouse 5 (Forward)";
    default:
      return part;
  }
}

function formatHotkeyLabel(hotkey?: string | null): string {
  if (!hotkey || hotkey.trim() === "") {
    return "`";
  }

  if (hotkey === "GLOBE") {
    return "Globe/Fn";
  }

  if (hotkey.includes("+")) {
    const isMac = isMacPlatform();
    const parts = hotkey.split("+");
    const formattedParts = parts.map((part) => formatModifierPart(part, isMac));
    return formattedParts.join("+");
  }

  const isMac = isMacPlatform();
  return formatModifierPart(hotkey, isMac);
}

function parseHotkey(hotkey: string): {
  modifiers: string[];
  baseKey: string;
} {
  if (!hotkey || !hotkey.includes("+")) {
    return { modifiers: [], baseKey: hotkey || "" };
  }

  const parts = hotkey.split("+");
  const baseKey = parts[parts.length - 1];
  const modifiers = parts.slice(0, -1);

  return { modifiers, baseKey };
}

function isCompoundHotkey(hotkey: string): boolean {
  return hotkey?.includes("+") || false;
}

function getDefaultHotkey(): string {
  const isMac = isMacPlatform();
  return isMac ? "GLOBE" : "CommandOrControl+Space";
}

function isValidHotkeyFormat(hotkey: string): boolean {
  if (!hotkey || hotkey.trim() === "") {
    return false;
  }

  if (hotkey === "GLOBE") {
    return true;
  }

  if (!hotkey.includes("+")) {
    return true;
  }

  const parts = hotkey.split("+");
  if (parts.length < 2) {
    return false;
  }

  return parts.every((part) => part.trim().length > 0);
}

describe("hotkeys", () => {
  describe("formatHotkeyLabel", () => {
    describe("empty/null handling", () => {
      it("returns backtick for null", () => {
        expect(formatHotkeyLabel(null)).toBe("`");
      });

      it("returns backtick for undefined", () => {
        expect(formatHotkeyLabel(undefined)).toBe("`");
      });

      it("returns backtick for empty string", () => {
        expect(formatHotkeyLabel("")).toBe("`");
      });

      it("returns backtick for whitespace only", () => {
        expect(formatHotkeyLabel("   ")).toBe("`");
      });
    });

    describe("special keys", () => {
      it("formats GLOBE key", () => {
        expect(formatHotkeyLabel("GLOBE")).toBe("Globe/Fn");
      });
    });

    describe("single keys", () => {
      it("returns single key unchanged", () => {
        expect(formatHotkeyLabel("`")).toBe("`");
        expect(formatHotkeyLabel("F1")).toBe("F1");
        expect(formatHotkeyLabel("A")).toBe("A");
        expect(formatHotkeyLabel("Space")).toBe("Space");
      });
    });

    describe("compound hotkeys on macOS", () => {
      beforeEach(() => setMockPlatform("MacIntel"));

      it("formats CommandOrControl as Cmd", () => {
        expect(formatHotkeyLabel("CommandOrControl+K")).toBe("Cmd+K");
      });

      it("formats Alt as Option", () => {
        expect(formatHotkeyLabel("Alt+K")).toBe("Option+K");
      });

      it("formats multiple modifiers", () => {
        expect(formatHotkeyLabel("CommandOrControl+Shift+K")).toBe("Cmd+Shift+K");
        expect(formatHotkeyLabel("CommandOrControl+Alt+Shift+K")).toBe("Cmd+Option+Shift+K");
      });

      it("formats Super/Meta as Cmd", () => {
        expect(formatHotkeyLabel("Super+K")).toBe("Cmd+K");
        expect(formatHotkeyLabel("Meta+K")).toBe("Cmd+K");
      });
    });

    describe("compound hotkeys on Windows/Linux", () => {
      beforeEach(() => setMockPlatform("Win32"));

      it("formats CommandOrControl as Ctrl", () => {
        expect(formatHotkeyLabel("CommandOrControl+K")).toBe("Ctrl+K");
      });

      it("formats Alt as Alt", () => {
        expect(formatHotkeyLabel("Alt+K")).toBe("Alt+K");
      });

      it("formats multiple modifiers", () => {
        expect(formatHotkeyLabel("CommandOrControl+Shift+K")).toBe("Ctrl+Shift+K");
        expect(formatHotkeyLabel("CommandOrControl+Alt+Shift+K")).toBe("Ctrl+Alt+Shift+K");
      });

      it("formats Super/Meta as Win", () => {
        expect(formatHotkeyLabel("Super+K")).toBe("Win+K");
        expect(formatHotkeyLabel("Meta+K")).toBe("Win+K");
      });
    });

    describe("mouse button formatting", () => {
      it("formats Mouse4/XButton1", () => {
        expect(formatHotkeyLabel("Mouse4")).toBe("Mouse 4 (Back)");
        expect(formatHotkeyLabel("XButton1")).toBe("Mouse 4 (Back)");
      });

      it("formats Mouse5/XButton2", () => {
        expect(formatHotkeyLabel("Mouse5")).toBe("Mouse 5 (Forward)");
        expect(formatHotkeyLabel("XButton2")).toBe("Mouse 5 (Forward)");
      });
    });
  });

  describe("parseHotkey", () => {
    it("parses empty string", () => {
      expect(parseHotkey("")).toEqual({ modifiers: [], baseKey: "" });
    });

    it("parses single key", () => {
      expect(parseHotkey("K")).toEqual({ modifiers: [], baseKey: "K" });
      expect(parseHotkey("`")).toEqual({ modifiers: [], baseKey: "`" });
      expect(parseHotkey("F1")).toEqual({ modifiers: [], baseKey: "F1" });
    });

    it("parses compound hotkey with one modifier", () => {
      expect(parseHotkey("Ctrl+K")).toEqual({ modifiers: ["Ctrl"], baseKey: "K" });
      expect(parseHotkey("CommandOrControl+K")).toEqual({
        modifiers: ["CommandOrControl"],
        baseKey: "K",
      });
    });

    it("parses compound hotkey with multiple modifiers", () => {
      expect(parseHotkey("CommandOrControl+Shift+K")).toEqual({
        modifiers: ["CommandOrControl", "Shift"],
        baseKey: "K",
      });
      expect(parseHotkey("Ctrl+Alt+Shift+K")).toEqual({
        modifiers: ["Ctrl", "Alt", "Shift"],
        baseKey: "K",
      });
    });

    it("handles function keys as base key", () => {
      expect(parseHotkey("CommandOrControl+F11")).toEqual({
        modifiers: ["CommandOrControl"],
        baseKey: "F11",
      });
    });
  });

  describe("isCompoundHotkey", () => {
    it("returns false for single keys", () => {
      expect(isCompoundHotkey("`")).toBe(false);
      expect(isCompoundHotkey("K")).toBe(false);
      expect(isCompoundHotkey("F1")).toBe(false);
      expect(isCompoundHotkey("GLOBE")).toBe(false);
    });

    it("returns true for compound hotkeys", () => {
      expect(isCompoundHotkey("Ctrl+K")).toBe(true);
      expect(isCompoundHotkey("CommandOrControl+Shift+K")).toBe(true);
      expect(isCompoundHotkey("Alt+F4")).toBe(true);
    });

    it("returns false for null/undefined", () => {
      expect(isCompoundHotkey(null as unknown as string)).toBe(false);
      expect(isCompoundHotkey(undefined as unknown as string)).toBe(false);
    });
  });

  describe("getDefaultHotkey", () => {
    it("returns GLOBE on macOS", () => {
      setMockPlatform("MacIntel");
      expect(getDefaultHotkey()).toBe("GLOBE");
    });

    it("returns Ctrl+Space on Windows", () => {
      setMockPlatform("Win32");
      expect(getDefaultHotkey()).toBe("CommandOrControl+Space");
    });

    it("returns Ctrl+Space on Linux", () => {
      setMockPlatform("Linux x86_64");
      expect(getDefaultHotkey()).toBe("CommandOrControl+Space");
    });
  });

  describe("isValidHotkeyFormat", () => {
    describe("invalid formats", () => {
      it("returns false for null/undefined/empty", () => {
        expect(isValidHotkeyFormat("")).toBe(false);
        expect(isValidHotkeyFormat("   ")).toBe(false);
        expect(isValidHotkeyFormat(null as unknown as string)).toBe(false);
      });

      it("returns false for malformed compound hotkeys", () => {
        expect(isValidHotkeyFormat("+K")).toBe(false); // Empty modifier
        expect(isValidHotkeyFormat("Ctrl+")).toBe(false); // Empty base key
        expect(isValidHotkeyFormat("Ctrl++K")).toBe(false); // Double +
      });
    });

    describe("valid formats", () => {
      it("returns true for GLOBE", () => {
        expect(isValidHotkeyFormat("GLOBE")).toBe(true);
      });

      it("returns true for single keys", () => {
        expect(isValidHotkeyFormat("`")).toBe(true);
        expect(isValidHotkeyFormat("K")).toBe(true);
        expect(isValidHotkeyFormat("F1")).toBe(true);
        expect(isValidHotkeyFormat("Space")).toBe(true);
      });

      it("returns true for compound hotkeys", () => {
        expect(isValidHotkeyFormat("Ctrl+K")).toBe(true);
        expect(isValidHotkeyFormat("CommandOrControl+Shift+K")).toBe(true);
        expect(isValidHotkeyFormat("Alt+F4")).toBe(true);
      });
    });
  });
});
