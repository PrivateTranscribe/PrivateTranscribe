import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * When the history could not be read from the database, the main process
 * answered with an object, { success: true, data: [] }, where every caller
 * expects the list itself. The store kept that object as the list, and the
 * History and Dashboard pages crashed on it into the "something went wrong"
 * screen.
 */
describe("the history list when the database could not be read", () => {
  beforeEach(() => {
    vi.resetModules();
    // The store hooks the page unload; the test window has no events.
    (window as any).addEventListener = vi.fn();
  });

  it("is an empty list, and still takes the next dictation", async () => {
    window.electronAPI = {
      getTranscriptions: vi.fn().mockResolvedValue({ success: true, data: [] }),
    } as any;
    const store = await import("../../../src/stores/transcriptionStore");

    const list = await store.initializeTranscriptions();

    expect(list).toEqual([]);
    expect(() =>
      store.addTranscription({ id: 1, text: "Hello.", timestamp: "2026-11-10 02:00:00" } as any)
    ).not.toThrow();
  });

  it("keeps the list the database returned", async () => {
    const saved = [{ id: 7, text: "Saved.", timestamp: "2026-11-09 20:00:00" }];
    window.electronAPI = { getTranscriptions: vi.fn().mockResolvedValue(saved) } as any;
    const store = await import("../../../src/stores/transcriptionStore");

    expect(await store.initializeTranscriptions()).toEqual(saved);
  });
});

/**
 * The handler's own answer. It is read from the source because the handler
 * class cannot be built in a unit test without the whole main process.
 */
describe("the db-get-transcriptions handler", () => {
  it("answers a database error with an empty list, the shape its callers expect", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const source = fs.readFileSync(
      path.join(process.cwd(), "src", "helpers", "ipcHandlers.js"),
      "utf8"
    );
    const start = source.indexOf('ipcMain.handle("db-get-transcriptions"');
    const handler = source.slice(start, source.indexOf("ipcMain.handle(", start + 1));

    expect(handler).toContain("return [];");
    expect(handler).not.toContain("data: []");
  });
});
