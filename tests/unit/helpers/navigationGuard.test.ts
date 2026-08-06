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

const openExternal = vi.fn(() => Promise.resolve());

async function loadGuard() {
  const mod = await import("../../../src/helpers/navigationGuard.js");
  return { ...mod, openExternal };
}

const DEV_URL = "http://localhost:5174/";

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
  it("accepts packaged app content loaded from disk", async () => {
    const { isInternalUrl } = await loadGuard();
    expect(isInternalUrl("file:///C:/app/src/dist/index.html")).toBe(true);
  });

  it("accepts the dev server origin only when one is configured", async () => {
    const { isInternalUrl } = await loadGuard();
    expect(isInternalUrl("http://localhost:5174/?panel=true", DEV_URL)).toBe(true);
    expect(isInternalUrl("http://localhost:5174/", null)).toBe(false);
  });

  it("rejects remote origins and a look-alike dev host", async () => {
    const { isInternalUrl } = await loadGuard();
    expect(isInternalUrl("https://evil.example/", DEV_URL)).toBe(false);
    expect(isInternalUrl("http://localhost:9999/", DEV_URL)).toBe(false);
    expect(isInternalUrl("http://localhost.evil.example/", DEV_URL)).toBe(false);
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
