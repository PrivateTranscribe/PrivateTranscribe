import { describe, expect, test, vi } from "vitest";
import { deliverDictation } from "../../../src/utils/dictationDelivery";

describe("deliverDictation", () => {
  test.each([false, true])(
    "leaves a preserved clipboard untouched while a target reads it (copy preference %s)",
    async (shouldCopy) => {
      const copy = vi.fn(async () => {
        throw new Error("target is reading the clipboard");
      });
      const result = await deliverDictation({
        text: "recoverable transcript",
        shouldPersist: false,
        shouldPaste: true,
        shouldCopy,
        persist: vi.fn(),
        paste: vi.fn(async () => ({
          delivered: false,
          dispatched: true,
          evidence: "none",
          clipboardPreserved: true,
        })),
        copy,
      });
      expect(copy).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        pasteConfirmed: false,
        pasteDispatched: true,
        copied: true,
        recoverable: true,
        outputAction: "copy-fallback",
      });
    }
  );

  test("persists completed text before paste and copies it when paste is not confirmed", async () => {
    const calls: string[] = [];
    const persist = vi.fn(async () => {
      calls.push("persist");
      return true;
    });
    const paste = vi.fn(async () => {
      calls.push("paste");
      return false;
    });
    const copy = vi.fn(async () => {
      calls.push("copy");
    });

    const result = await deliverDictation({
      text: "recoverable transcript",
      shouldPersist: true,
      shouldPaste: true,
      shouldCopy: false,
      persist,
      paste,
      copy,
    });

    expect(calls).toEqual(["persist", "paste", "copy"]);
    expect(copy).toHaveBeenCalledWith("recoverable transcript");
    expect(result).toEqual({
      persisted: true,
      pasteConfirmed: false,
      pasteEvidence: null,
      pasteDispatched: false,
      copied: true,
      outputAction: "copy-fallback",
      recoverable: true,
    });
  });

  // A paste into an elevated window, a password field or a game reports "none":
  // the helper saw nothing either way. The caller uses this to stay quiet rather
  // than claim a failure it cannot back, so it has to survive the trip.
  test("carries what the paste attempt could observe back to the caller", async () => {
    const result = await deliverDictation({
      text: "unverifiable transcript",
      shouldPersist: true,
      shouldPaste: true,
      shouldCopy: false,
      persist: vi.fn(async () => true),
      paste: vi.fn(async () => ({ delivered: false, evidence: "none" })),
      copy: vi.fn(async () => {}),
    });

    expect(result.pasteConfirmed).toBe(false);
    expect(result.pasteEvidence).toBe("none");
    // Still copied, because the clipboard is the only route left that the user
    // can reach without opening the control panel.
    expect(result.copied).toBe(true);
    expect(result.outputAction).toBe("copy-fallback");
  });

  test("still reads a plain boolean paste result", async () => {
    const result = await deliverDictation({
      text: "confirmed transcript",
      shouldPersist: false,
      shouldPaste: true,
      shouldCopy: false,
      persist: vi.fn(async () => true),
      paste: vi.fn(async () => true),
      copy: vi.fn(async () => {}),
    });

    expect(result.pasteConfirmed).toBe(true);
    expect(result.pasteEvidence).toBe(null);
    expect(result.outputAction).toBe("paste");
  });

  test("preserves dispatch despite stale accessible text and keeps a recovery copy", async () => {
    const copy = vi.fn(async () => {});
    const result = await deliverDictation({
      text: "Text that landed in a browser editor",
      shouldPersist: true,
      shouldPaste: true,
      shouldCopy: false,
      persist: vi.fn(async () => true),
      paste: vi.fn(async () => ({ delivered: false, dispatched: true, evidence: "absent" })),
      copy,
    });
    expect(result).toMatchObject({ pasteConfirmed: false, pasteDispatched: true, copied: true });
    expect(copy).toHaveBeenCalledOnce();
  });

  test("reports when every durable delivery path failed", async () => {
    const result = await deliverDictation({
      text: "irreplaceable text",
      shouldPersist: true,
      shouldPaste: true,
      shouldCopy: true,
      persist: vi.fn().mockResolvedValue(false),
      paste: vi.fn().mockResolvedValue(false),
      copy: vi.fn().mockRejectedValue(new Error("clipboard unavailable")),
    });

    expect(result).toMatchObject({
      persisted: false,
      pasteConfirmed: false,
      copied: false,
      recoverable: false,
    });
  });

  test("counts a completed voice action as confirmed delivery", async () => {
    const result = await deliverDictation({
      text: "run my action",
      shouldPersist: false,
      shouldPaste: false,
      shouldCopy: false,
      additionalConfirmedDelivery: true,
      persist: vi.fn(),
      paste: vi.fn(),
      copy: vi.fn(),
    });

    expect(result.recoverable).toBe(true);
  });
});
