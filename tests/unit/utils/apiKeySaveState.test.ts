/**
 * Which API keys read as saved on the AI Enhancement card.
 * @module tests/unit/utils/apiKeySaveState
 *
 * A key field saves on every keystroke, and saves can finish out of order, so
 * only the latest save of a key decides whether it reads as saved.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

async function freshStore() {
  vi.resetModules();
  return import("../../../src/utils/apiKeySaveState");
}

describe("apiKeySaveState", () => {
  let store: Awaited<ReturnType<typeof freshStore>>;

  beforeEach(async () => {
    store = await freshStore();
  });

  it("marks a key not saved when its latest save fails, and saved once one succeeds", () => {
    const failed = store.beginApiKeySave("openai");
    expect(store.finishApiKeySave("openai", failed, false)).toBe(true);
    expect(store.isApiKeyUnsaved("openai")).toBe(true);

    const saved = store.beginApiKeySave("openai");
    expect(store.finishApiKeySave("openai", saved, true)).toBe(true);
    expect(store.isApiKeyUnsaved("openai")).toBe(false);
  });

  it("ignores a failure that arrives after a later save succeeded", () => {
    const first = store.beginApiKeySave("groq");
    const second = store.beginApiKeySave("groq");
    store.finishApiKeySave("groq", second, true);

    expect(store.finishApiKeySave("groq", first, false)).toBe(false);
    expect(store.isApiKeyUnsaved("groq")).toBe(false);
  });

  it("keeps each key's state apart", () => {
    store.finishApiKeySave("openai", store.beginApiKeySave("openai"), false);

    expect(store.isApiKeyUnsaved("openai")).toBe(true);
    expect(store.isApiKeyUnsaved("anthropic")).toBe(false);
  });

  it("tells subscribers only when a key's state changes", () => {
    const listener = vi.fn();
    const unsubscribe = store.subscribeApiKeySaves(listener);

    store.finishApiKeySave("gemini", store.beginApiKeySave("gemini"), true);
    expect(listener).not.toHaveBeenCalled();
    store.finishApiKeySave("gemini", store.beginApiKeySave("gemini"), false);
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    store.finishApiKeySave("gemini", store.beginApiKeySave("gemini"), true);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
