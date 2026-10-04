/**
 * Tests for the window navigation guard.
 * @module tests/unit/helpers/navigationGuard
 *
 * The renderer is sandboxed and context-isolated, but the preload bridge is
 * re-attached on every navigation, so navigating a window to third-party
 * content would expose privileged IPC to a remote origin. These tests pin the
 * deny-by-default behaviour and confirm app content still loads.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import path from "path";
import { pathToFileURL } from "url";

const openExternal = vi.fn(() => Promise.resolve());

async function loadGuard() {
  const mod = await import("../../../src/helpers/navigationGuard.js");
  return { ...mod, openExternal };
}

const DEV_URL = "http://localhost:5174/";

// Built from this platform's own root, so the paths are absolute on Windows and POSIX alike.
const DISK_ROOT = path.parse(process.cwd()).root;
const APP_DIR = path.join(DISK_ROOT, "Program Files", "PrivateTranscribe");
const DIST_DIR = path.join(APP_DIR, "resources", "app.asar", "src", "dist");
const ENTRY_PATH = path.join(DIST_DIR, "index.html");
const ENTRY_URL = pathToFileURL(ENTRY_PATH).href;
const SIBLING_URL = pathToFileURL(path.join(DIST_DIR, "dropped.html")).href;
const DOWNLOADS_DIR = path.join(DISK_ROOT, "Users", "me", "Downloads");
const ELSEWHERE_URL = pathToFileURL(path.join(DOWNLOADS_DIR, "index.html")).href;
const UNC_URL = "file://fileserver/share/index.html";

/** Minimal WebContents stand-in that records handlers. */
function makeWebContents() {
  const listeners: Record<string, ((...args: unknown[]) => void)[]> = {};
  let windowOpenHandler: ((details: { url: string }) => unknown) | null = null;

  return {
    on(event: string, cb: (...args: unknown[]) => void) {
      (listeners[event] ||= []).push(cb);
    },
    setWindowOpenHandler(handler: (details: { url: string }) => unknown) {
      windowOpenHandler = handler;
    },
    emit(event: string, ...args: unknown[]) {
      (listeners[event] || []).forEach((cb) => cb(...args));
    },
    openWindow(url: string) {
      return windowOpenHandler?.({ url });
    },
  };
}

beforeEach(async () => {
  const { openExternal } = await loadGuard();
  openExternal.mockClear();
});

describe("isInternalUrl", () => {
  it("accepts the renderer entry with any query or hash", async () => {
    const { isInternalUrl } = await loadGuard();
    const sources = { appEntryPath: ENTRY_PATH };
    expect(isInternalUrl(ENTRY_URL, sources)).toBe(true);
    expect(isInternalUrl(`${ENTRY_URL}?panel=true`, sources)).toBe(true);
    expect(isInternalUrl(`${ENTRY_URL}#/settings`, sources)).toBe(true);
  });

  it("decodes and normalises the URL before comparing it with the entry", async () => {
    const { isInternalUrl } = await loadGuard();
    const sources = { appEntryPath: ENTRY_PATH };
    // "Program Files" arrives as Program%20Files, the way Chromium reports it.
    expect(ENTRY_URL).toContain("Program%20Files");
    expect(isInternalUrl(ENTRY_URL.replace("/dist/", "/dist/sub/../"), sources)).toBe(true);
  });

  it("ignores case on Windows only", async () => {
    const { isInternalUrl } = await loadGuard();
    const shouted = ENTRY_URL.replace("index.html", "INDEX.HTML");
    expect(isInternalUrl(shouted, { appEntryPath: ENTRY_PATH })).toBe(process.platform === "win32");
  });

  it("rejects every file URL when no entry path is configured", async () => {
    const { isInternalUrl } = await loadGuard();
    expect(isInternalUrl(ENTRY_URL)).toBe(false);
    expect(isInternalUrl(ENTRY_URL, { devServerUrl: DEV_URL })).toBe(false);
  });

  it("rejects files beside the entry, elsewhere on disk, and on network shares", async () => {
    const { isInternalUrl } = await loadGuard();
    const sources = { appEntryPath: ENTRY_PATH };
    expect(isInternalUrl(SIBLING_URL, sources)).toBe(false);
    expect(isInternalUrl(ELSEWHERE_URL, sources)).toBe(false);
    expect(isInternalUrl(UNC_URL, sources)).toBe(false);
    // A share whose path mirrors the entry is still somebody else's file.
    expect(isInternalUrl(`file://fileserver${new URL(ENTRY_URL).pathname}`, sources)).toBe(false);
  });

  it("rejects a path with an encoded separator", async () => {
    const { isInternalUrl } = await loadGuard();
    const encoded = ENTRY_URL.replace("/dist/index.html", "/dist%2Findex.html");
    expect(isInternalUrl(encoded, { appEntryPath: ENTRY_PATH })).toBe(false);
  });

  it("accepts the dev server origin only when one is configured", async () => {
    const { isInternalUrl } = await loadGuard();
    expect(isInternalUrl("http://localhost:5174/?panel=true", { devServerUrl: DEV_URL })).toBe(
      true
    );
    expect(isInternalUrl("http://localhost:5174/", { devServerUrl: null })).toBe(false);
  });

  it("rejects remote origins and a look-alike dev host", async () => {
    const { isInternalUrl } = await loadGuard();
    const sources = { devServerUrl: DEV_URL, appEntryPath: ENTRY_PATH };
    expect(isInternalUrl("https://evil.example/", sources)).toBe(false);
    expect(isInternalUrl("http://localhost:9999/", sources)).toBe(false);
    expect(isInternalUrl("http://localhost.evil.example/", sources)).toBe(false);
  });

  it("rejects unparseable input", async () => {
    const { isInternalUrl } = await loadGuard();
    expect(isInternalUrl("not a url")).toBe(false);
  });
});

describe("isAllowedExternalUrl", () => {
  it("allows web and mail links", async () => {
    const { isAllowedExternalUrl } = await loadGuard();
    expect(isAllowedExternalUrl("https://privatetranscribe.com")).toBe(true);
    expect(isAllowedExternalUrl("mailto:support@privatetranscribe.com")).toBe(true);
  });

  it("blocks scripting and local-file protocols", async () => {
    const { isAllowedExternalUrl } = await loadGuard();
    expect(isAllowedExternalUrl("javascript:alert(1)")).toBe(false);
    expect(isAllowedExternalUrl("file:///etc/passwd")).toBe(false);
    expect(isAllowedExternalUrl("data:text/html,<script>")).toBe(false);
  });
});

describe("applyNavigationGuard", () => {
  it("lets the app navigate to its own content", async () => {
    const { applyNavigationGuard, openExternal } = await loadGuard();
    const wc = makeWebContents();
    applyNavigationGuard(wc, { devServerUrl: DEV_URL, openExternal });

    const event = { preventDefault: vi.fn() };
    wc.emit("will-navigate", event, "http://localhost:5174/?panel=true");

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(openExternal).not.toHaveBeenCalled();
  });

  it("blocks navigation to a remote origin and sends it to the browser", async () => {
    const { applyNavigationGuard, openExternal } = await loadGuard();
    const wc = makeWebContents();
    applyNavigationGuard(wc, { devServerUrl: DEV_URL, openExternal });

    const event = { preventDefault: vi.fn() };
    wc.emit("will-navigate", event, "https://evil.example/phish");

    expect(event.preventDefault).toHaveBeenCalled();
    expect(openExternal).toHaveBeenCalledWith("https://evil.example/phish");
  });

  it("blocks a javascript: navigation without handing it to the shell", async () => {
    const { applyNavigationGuard, openExternal } = await loadGuard();
    const wc = makeWebContents();
    applyNavigationGuard(wc, { openExternal });

    const event = { preventDefault: vi.fn() };
    wc.emit("will-navigate", event, "javascript:alert(1)");

    expect(event.preventDefault).toHaveBeenCalled();
    expect(openExternal).not.toHaveBeenCalled();
  });

  it("denies window.open but still opens http(s) targets externally", async () => {
    const { applyNavigationGuard, openExternal } = await loadGuard();
    const wc = makeWebContents();
    applyNavigationGuard(wc, { openExternal });

    expect(wc.openWindow("https://github.com/PrivateTranscribe")).toEqual({ action: "deny" });
    expect(openExternal).toHaveBeenCalledWith("https://github.com/PrivateTranscribe");
  });

  it("denies window.open for unsafe protocols without invoking the shell", async () => {
    const { applyNavigationGuard, openExternal } = await loadGuard();
    const wc = makeWebContents();
    applyNavigationGuard(wc, { openExternal });

    expect(wc.openWindow("file:///etc/passwd")).toEqual({ action: "deny" });
    expect(openExternal).not.toHaveBeenCalled();
  });

  it("refuses webview attachment", async () => {
    const { applyNavigationGuard } = await loadGuard();
    const wc = makeWebContents();
    applyNavigationGuard(wc, { openExternal });

    const event = { preventDefault: vi.fn() };
    wc.emit("will-attach-webview", event);

    expect(event.preventDefault).toHaveBeenCalled();
  });

  it("reports blocked targets to the caller", async () => {
    const { applyNavigationGuard } = await loadGuard();
    const wc = makeWebContents();
    const onBlocked = vi.fn();
    applyNavigationGuard(wc, { onBlocked, openExternal });

    wc.emit("will-navigate", { preventDefault: vi.fn() }, "https://evil.example/");

    expect(onBlocked).toHaveBeenCalledWith("https://evil.example/");
  });
});

describe("applyNavigationGuard with an app entry path", () => {
  /** Guard a window with both app sources configured and send one in-app navigation at it. */
  async function navigate(url: string) {
    const { applyNavigationGuard, openExternal } = await loadGuard();
    const wc = makeWebContents();
    const onBlocked = vi.fn();
    applyNavigationGuard(wc, {
      devServerUrl: DEV_URL,
      appEntryPath: ENTRY_PATH,
      onBlocked,
      openExternal,
    });

    const event = { preventDefault: vi.fn() };
    wc.emit("will-navigate", event, url);
    return { event, onBlocked, openExternal };
  }

  it.each([
    ["the app entry", ENTRY_URL],
    ["the app entry with ?panel=true", `${ENTRY_URL}?panel=true`],
    ["the dev server origin", `${DEV_URL}?panel=true`],
  ])("allows %s", async (_name, url) => {
    const { event, onBlocked, openExternal } = await navigate(url);

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(onBlocked).not.toHaveBeenCalled();
    expect(openExternal).not.toHaveBeenCalled();
  });

  it.each([
    ["another file in the same folder", SIBLING_URL],
    ["a file elsewhere on disk", ELSEWHERE_URL],
    ["a file on a network share", UNC_URL],
  ])("blocks %s without handing it to the shell", async (_name, url) => {
    const { event, onBlocked, openExternal } = await navigate(url);

    expect(event.preventDefault).toHaveBeenCalled();
    expect(onBlocked).toHaveBeenCalledWith(url);
    expect(openExternal).not.toHaveBeenCalled();
  });

  it("blocks an http page and opens it in the browser instead", async () => {
    const { event, openExternal } = await navigate("http://example.com/page.html");

    expect(event.preventDefault).toHaveBeenCalled();
    expect(openExternal).toHaveBeenCalledWith("http://example.com/page.html");
  });
});
