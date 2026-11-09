import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { MicrophoneAccess, wantsAudio } = require("../../../src/helpers/microphoneAccess");

type RequestHandler = (
  webContents: unknown,
  permission: string,
  callback: (granted: boolean) => void,
  details: Record<string, unknown>
) => void;
type CheckHandler = (
  webContents: unknown,
  permission: string,
  origin: string,
  details: Record<string, unknown>
) => boolean;

function fakeSession() {
  const handlers: { request?: RequestHandler; check?: CheckHandler } = {};
  return {
    handlers,
    setPermissionRequestHandler: (fn: RequestHandler) => (handlers.request = fn),
    setPermissionCheckHandler: (fn: CheckHandler) => (handlers.check = fn),
  };
}

/** A window whose localStorage says whether the old setup was finished. */
function fakeWindow(onboardingCompleted: string | null) {
  return {
    isDestroyed: () => false,
    getURL: () => "file:///index.html",
    executeJavaScript: async () => onboardingCompleted,
  };
}

function ask(handler: RequestHandler, webContents: unknown, mediaTypes: string[] = ["audio"]) {
  return new Promise<boolean>((resolve) => handler(webContents, "media", resolve, { mediaTypes }));
}

describe("MicrophoneAccess", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-mic-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("refuses the microphone on a fresh install until Allow", async () => {
    const access = new MicrophoneAccess({ userDataPath: dir });
    const session = fakeSession();
    access.install(session);
    const win = fakeWindow(null);

    expect(await ask(session.handlers.request!, win)).toBe(false);
    expect(session.handlers.check!(win, "media", "file://", { mediaType: "audio" })).toBe(false);

    access.allow();
    expect(await ask(session.handlers.request!, win)).toBe(true);
    expect(session.handlers.check!(win, "media", "file://", { mediaType: "audio" })).toBe(true);
  });

  it("remembers Allow across a restart", () => {
    new MicrophoneAccess({ userDataPath: dir }).allow();
    const restarted = new MicrophoneAccess({ userDataPath: dir });
    expect(restarted.isAllowed()).toBe(true);
  });

  it("keeps the microphone working for a user who finished the old setup", async () => {
    const access = new MicrophoneAccess({ userDataPath: dir });
    const session = fakeSession();
    access.install(session);

    expect(await ask(session.handlers.request!, fakeWindow("true"))).toBe(true);
    // Saved, so a later answer no longer depends on the renderer.
    const restarted = new MicrophoneAccess({ userDataPath: dir });
    expect(restarted.getState()).toMatchObject({
      allowed: true,
      source: "finished-setup-before-gate",
    });
  });

  it("never saves a refusal for an unfinished setup", async () => {
    const access = new MicrophoneAccess({ userDataPath: dir });
    expect(await access.resolve(fakeWindow("false"))).toBe(false);
    expect(access.getState().decided).toBe(false);
    expect(fs.existsSync(path.join(dir, "microphone-access.json"))).toBe(false);
  });

  it("leaves every other permission as Electron answered it before", async () => {
    const access = new MicrophoneAccess({ userDataPath: dir });
    const session = fakeSession();
    access.install(session);
    const win = fakeWindow(null);
    const granted = await new Promise<boolean>((resolve) =>
      session.handlers.request!(win, "clipboard-read", resolve, {})
    );
    expect(granted).toBe(true);
    expect(await ask(session.handlers.request!, win, ["video"])).toBe(true);
  });

  it("reads a request with no media types as audio", () => {
    expect(wantsAudio(undefined)).toBe(true);
    expect(wantsAudio([])).toBe(true);
    expect(wantsAudio(["video"])).toBe(false);
  });
});
