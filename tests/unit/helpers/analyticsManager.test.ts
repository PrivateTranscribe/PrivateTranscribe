import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: {
    getVersion: () => "0.13.6",
    getPath: () => "/tmp/private-transcribe-analytics-test",
  },
}));

async function loadAnalyticsManager() {
  const module = await import("../../../src/helpers/analyticsManager.js");
  return (module.default ?? module) as any;
}

beforeEach(() => {
  // These cover an official build; a copy built from source never sends.
  vi.stubEnv("PRIVATETRANSCRIBE_OFFICIAL_BUILD", "1");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("analytics manager privacy boundary", () => {
  it("requires renewed consent when an older grant predates expanded telemetry", async () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    const readConsent = vi.spyOn(fs, "readFileSync");
    const manager = await loadAnalyticsManager();

    readConsent.mockReturnValue("granted" as never);
    expect(manager._loadConsent()).toBeNull();

    readConsent.mockReturnValue("granted:v2" as never);
    expect(manager._loadConsent()).toBe("granted");

    readConsent.mockReturnValue("denied" as never);
    expect(manager._loadConsent()).toBe("denied");
  });

  it("stores the current disclosure version with the consent choice", async () => {
    const writeConsent = vi.spyOn(fs, "writeFileSync").mockImplementation(() => undefined);
    const manager = await loadAnalyticsManager();
    manager._consent = "granted";

    manager.setConsent(true);

    expect(writeConsent).toHaveBeenCalledWith(
      expect.stringMatching(/analytics-consent\.txt$/),
      "granted:v2",
      "utf8"
    );
  });

  it("does not contact the backend without consent", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const manager = await loadAnalyticsManager();
    manager._consent = "denied";

    await expect(manager.track("transcription_completed")).resolves.toEqual({
      sent: false,
      reason: "consent-not-granted",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("nests only constrained properties in the backend payload", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 201 });
    vi.stubGlobal("fetch", fetchMock);
    const manager = await loadAnalyticsManager();
    manager._consent = "granted";
    manager._deviceId = "00000000-0000-4000-8000-000000000000";
    manager._supabaseAnonKey = "test-publishable-key";

    await expect(
      manager.track("transcription_completed", {
        source: "local-parakeet",
        output_action: "paste",
        transcript: "must not leave the device",
        window_title: "private window",
      })
    ).resolves.toEqual({ sent: true });

    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const payload = JSON.parse(String(request.body));
    expect(payload).toMatchObject({
      device_id: "00000000-0000-4000-8000-000000000000",
      event: "transcription_completed",
      properties: {
        source: "local-parakeet",
        output_action: "paste",
      },
    });
    expect(typeof payload.app_version).toBe("string");
    expect(payload).not.toHaveProperty("transcript");
    expect(payload.properties).not.toHaveProperty("transcript");
    expect(JSON.stringify(payload)).not.toContain("must not leave the device");
    expect(JSON.stringify(payload)).not.toContain("private window");
  });
});
