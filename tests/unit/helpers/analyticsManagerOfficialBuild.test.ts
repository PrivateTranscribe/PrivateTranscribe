import fs from "node:fs";
import Module, { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Only official release builds may send analytics. A copy built from source
 * (npm run dev, pack, build) can share userData with an installed copy, so it
 * must not read that install's consent, prompt for its own, or write a consent file.
 */

const require = createRequire(import.meta.url);

type ModuleLoader = (request: string, parent: unknown, isMain: boolean) => unknown;
const moduleWithLoader = Module as unknown as { _load: ModuleLoader };
const originalLoad = moduleWithLoader._load;

let appPath = "";
let userDataPath = "";

moduleWithLoader._load = (request, parent, isMain) => {
  if (request === "electron") {
    return {
      app: {
        getAppPath: () => appPath,
        getPath: () => userDataPath,
        getVersion: () => "0.20.2",
        isReady: () => false,
      },
    };
  }
  return originalLoad(request, parent, isMain);
};

const AnalyticsManager = require("../../../src/helpers/analyticsManager").constructor;

const OVERRIDE_ENV = "PRIVATETRANSCRIBE_OFFICIAL_BUILD";
const CONSENT_FILE = "analytics-consent.txt";
const DEVICE_ID_FILE = "device-id.txt";
const NOT_SENT = { sent: false, reason: "unofficial-build" };
const NOT_SAVED = { saved: false, reason: "unofficial-build" };

const savedOverride = process.env[OVERRIDE_ENV];
let fetchMock: ReturnType<typeof vi.fn>;

function writePackageJson(fields: Record<string, unknown>) {
  fs.writeFileSync(
    path.join(appPath, "package.json"),
    JSON.stringify({ name: "privatetranscribe", version: "0.20.2", ...fields })
  );
}

const consentFile = () => path.join(userDataPath, CONSENT_FILE);

function startManager() {
  const manager = new AnalyticsManager();
  manager.initialize();
  return manager;
}

beforeEach(() => {
  appPath = fs.mkdtempSync(path.join(os.tmpdir(), "pt-analytics-app-"));
  userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), "pt-analytics-userdata-"));
  delete process.env[OVERRIDE_ENV];
  fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 201 });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  fs.rmSync(appPath, { recursive: true, force: true });
  fs.rmSync(userDataPath, { recursive: true, force: true });
  if (savedOverride === undefined) {
    delete process.env[OVERRIDE_ENV];
  } else {
    process.env[OVERRIDE_ENV] = savedOverride;
  }
});

afterAll(() => {
  moduleWithLoader._load = originalLoad;
});

describe("analytics in a copy built from source", () => {
  it("ignores a grant the installed copy saved and sends nothing", async () => {
    writePackageJson({});
    fs.writeFileSync(consentFile(), "granted:v2");

    const manager = startManager();

    expect(manager.needsConsentPrompt()).toBe(false);
    expect(manager.getConsentStatus()).toBeNull();
    // The startup event main.js fires before any consent prompt.
    await expect(manager.track("app_launched")).resolves.toEqual(NOT_SENT);
    await expect(manager.track("transcription_completed")).resolves.toEqual(NOT_SENT);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(fs.readFileSync(consentFile(), "utf8")).toBe("granted:v2");
    expect(fs.existsSync(path.join(userDataPath, DEVICE_ID_FILE))).toBe(false);
  });

  it("refuses consent changes without writing a consent file", async () => {
    writePackageJson({});
    const manager = startManager();

    expect(manager.needsConsentPrompt()).toBe(false);
    expect(manager.setConsent(true)).toEqual(NOT_SAVED);
    expect(manager.setConsent(false)).toEqual(NOT_SAVED);

    // A grant would otherwise fire the post-consent app_launched event.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(fs.readdirSync(userDataPath)).toEqual([]);
  });

  it("checks the build before consent, so a grant in memory still sends nothing", async () => {
    writePackageJson({});
    const manager = new AnalyticsManager();
    manager._consent = "granted";
    manager._deviceId = "00000000-0000-4000-8000-000000000000";

    await expect(manager.track("app_launched")).resolves.toEqual(NOT_SENT);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("analytics in an official build", () => {
  it("asks on a fresh profile and records a refusal", async () => {
    writePackageJson({ privatetranscribeOfficialBuild: true });
    const manager = startManager();

    expect(manager.needsConsentPrompt()).toBe(true);
    expect(manager.setConsent(false)).toEqual({ saved: true });
    expect(fs.readFileSync(consentFile(), "utf8")).toBe("denied:v2");
    expect(manager.needsConsentPrompt()).toBe(false);
    await expect(manager.track("app_launched")).resolves.toEqual({
      sent: false,
      reason: "consent-not-granted",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends the startup event when consent was already granted", async () => {
    writePackageJson({ privatetranscribeOfficialBuild: true });
    fs.writeFileSync(consentFile(), "granted:v2");
    const manager = startManager();

    expect(manager.needsConsentPrompt()).toBe(false);
    await expect(manager.track("app_launched")).resolves.toEqual({ sent: true });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, request] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/rest\/v1\/usage_events$/);
    expect(JSON.parse(String(request.body))).toMatchObject({
      event: "app_launched",
      app_version: "0.20.2",
    });
  });

  it("records the launch once consent is granted", async () => {
    writePackageJson({ privatetranscribeOfficialBuild: "true" });
    const manager = startManager();

    expect(manager.setConsent(true)).toEqual({ saved: true });
    expect(fs.readFileSync(consentFile(), "utf8")).toBe("granted:v2");

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const request = fetchMock.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(String(request.body))).toMatchObject({
      event: "app_launched",
      properties: { launch_context: "consent_granted" },
    });
  });

  it("treats the test override as an official build", () => {
    writePackageJson({});
    process.env[OVERRIDE_ENV] = "1";
    const manager = startManager();

    expect(manager.needsConsentPrompt()).toBe(true);
    expect(manager.setConsent(false)).toEqual({ saved: true });
    expect(fs.readFileSync(consentFile(), "utf8")).toBe("denied:v2");
  });
});
