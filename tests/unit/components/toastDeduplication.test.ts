import { describe, expect, test } from "vitest";
import { getToastDedupeKey, upsertToast } from "../../../src/components/ui/toastState";

type TestToast = {
  id: string;
  dedupeKey: string;
  title: string;
  description: string;
  variant: "default" | "destructive" | "success";
  createdAt: number;
  isExiting: boolean;
};

function makeToast(overrides: Partial<TestToast> = {}): TestToast {
  const toast: TestToast = {
    id: "toast-1",
    title: "Loading the speech model",
    description: "The first dictation after launch takes longer while the model loads.",
    variant: "default",
    createdAt: 100,
    isExiting: false,
    dedupeKey: "",
    ...overrides,
  };
  return { ...toast, dedupeKey: getToastDedupeKey(toast) };
}

describe("toast deduplication", () => {
  test("replaces an identical toast in place and keeps one visible item", () => {
    const existing = makeToast({ isExiting: true });
    const repeated = makeToast({ id: "toast-2", createdAt: 500, isExiting: false });

    const result = upsertToast([existing], repeated);

    expect(result.replaced).toBe(true);
    expect(result.id).toBe(existing.id);
    expect(result.toasts).toHaveLength(1);
    expect(result.toasts[0]).toMatchObject({
      id: existing.id,
      createdAt: 500,
      isExiting: false,
    });
  });

  test("allows different notification content to stack", () => {
    const existing = makeToast();
    const different = makeToast({
      id: "toast-2",
      title: "Microphone unavailable",
      createdAt: 200,
    });

    const result = upsertToast([existing], different);

    expect(result.replaced).toBe(false);
    expect(result.toasts).toHaveLength(2);
  });

  test("treats variants as distinct notification identities", () => {
    const defaultToast = makeToast();
    const destructiveToast = makeToast({ id: "toast-2", variant: "destructive" });

    expect(defaultToast.dedupeKey).not.toBe(destructiveToast.dedupeKey);
  });
});
