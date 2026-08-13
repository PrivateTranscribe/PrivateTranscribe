import { describe, expect, test, vi } from "vitest";
import { deliverDictation } from "../../../src/utils/dictationDelivery";

describe("deliverDictation", () => {
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
      copied: true,
      outputAction: "copy-fallback",
      recoverable: true,
    });
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
