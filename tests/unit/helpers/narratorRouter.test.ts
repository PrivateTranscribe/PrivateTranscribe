import { describe, expect, it } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { NarratorRouter, MAX_ITEMS } = require("../../../src/helpers/narrator/router");

const event = (over: Record<string, unknown> = {}) => ({
  kind: "finished",
  chatId: "chat-a",
  chatTitle: "Chat A",
  recap: "Recap",
  ask: "",
  at: 1000,
  ...over,
});

describe("narrator router", () => {
  it("interrupts only for a chat that waits on the user", () => {
    const router = new NarratorRouter();
    expect(router.ingest(event({ kind: "waiting", ask: "Push?" })).action).toBe("interrupt");
    expect(router.ingest(event({ chatId: "chat-b" })).action).toBe("card");
  });

  it("files a wait found at startup as a card, not an interruption", () => {
    const router = new NarratorRouter();
    expect(router.ingest(event({ kind: "waiting", ask: "Push?", backlog: true })).action).toBe(
      "card"
    );
  });

  it("speaks a finish in a followed chat", () => {
    const router = new NarratorRouter();
    router.follow("chat-a");
    expect(router.ingest(event()).action).toBe("speak");
  });

  it("keeps one item per chat and drops a repeat of the same wait", () => {
    const router = new NarratorRouter();
    router.ingest(event());
    const wait = event({ kind: "waiting", ask: "Push?" });
    expect(router.ingest(wait).action).toBe("interrupt");
    expect(router.ingest(wait).action).toBe("ignore");
    expect(router.snapshot()).toHaveLength(1);
    expect(router.snapshot()[0].kind).toBe("waiting");
  });

  it("takes a turn in once, even when it is read again after its card left", () => {
    const router = new NarratorRouter();
    const wait = event({ kind: "waiting", ask: "Push?" });
    expect(router.ingest(wait).action).toBe("interrupt");
    router.ingest({ kind: "answered", chatId: "chat-a", at: 2000 });
    expect(router.ingest(wait).action).toBe("ignore");
    expect(router.ingest(event({ kind: "waiting", ask: "Push?", at: 3000 })).action).toBe(
      "interrupt"
    );
  });

  it("ignores a forked chat's copy of a turn, but not the fork's own turns", () => {
    const router = new NarratorRouter();
    router.ingest(event({ kind: "waiting", ask: "Push?" }));
    expect(router.ingest(event({ chatId: "fork", kind: "waiting", ask: "Push?" })).action).toBe(
      "ignore"
    );
    expect(
      router.ingest(event({ chatId: "fork", kind: "waiting", ask: "Merge?", at: 5000 })).action
    ).toBe("interrupt");
  });

  it("forgets items and turns on clear, and keeps the chats it follows", () => {
    const router = new NarratorRouter();
    router.follow("chat-a");
    const wait = event({ kind: "waiting", ask: "Push?" });
    router.ingest(wait);
    router.clear();
    expect(router.snapshot()).toHaveLength(0);
    expect(router.ingest(wait).action).toBe("interrupt");
    expect(router.isFollowed("chat-a")).toBe(true);
  });

  it("removes a chat's items when the user answers in it", () => {
    const router = new NarratorRouter();
    const { item } = router.ingest(event({ kind: "waiting", ask: "Push?" }));
    router.markHeard(item.id);
    expect(router.ingest({ kind: "answered", chatId: "chat-a", at: 2000 })).toEqual({
      action: "removed",
      removed: [item.id],
    });
    expect(router.snapshot()).toHaveLength(0);
    expect(router.current()).toBeNull();
  });

  it("briefs unheard items, waits first, newest first, and marks nothing itself", () => {
    const router = new NarratorRouter();
    router.ingest(event({ chatId: "old-finish", at: 1 }));
    router.ingest(event({ chatId: "new-finish", at: 3 }));
    router.ingest(event({ chatId: "wait", kind: "waiting", ask: "?", at: 2, backlog: true }));
    const ids = router.briefItems().map((item: { chatId: string }) => item.chatId);
    expect(ids).toEqual(["wait", "new-finish", "old-finish"]);
    expect(router.unheardCount()).toBe(3);
  });

  it("caps a brief and leaves the rest unheard", () => {
    const router = new NarratorRouter();
    for (let i = 0; i < 6; i += 1) router.ingest(event({ chatId: `c${i}`, at: i }));
    expect(router.briefItems()).toHaveLength(4);
  });

  it("ignores events without text or chat", () => {
    const router = new NarratorRouter();
    expect(router.ingest(event({ recap: "", ask: "" })).action).toBe("ignore");
    expect(router.ingest(event({ chatId: "" })).action).toBe("ignore");
    expect(router.ingest({ kind: "answered", chatId: "none", at: 1 }).action).toBe("ignore");
  });

  it("drops heard items first when it is full", () => {
    const router = new NarratorRouter();
    const first = router.ingest(event({ chatId: "keep-unheard", at: 0 })).item;
    const heard = router.ingest(event({ chatId: "heard", at: 1 })).item;
    router.markHeard(heard.id);
    for (let i = 0; i < MAX_ITEMS; i += 1) router.ingest(event({ chatId: `c${i}`, at: 10 + i }));
    expect(router.get(heard.id)).toBeNull();
    expect(router.snapshot()).toHaveLength(MAX_ITEMS);
    expect(router.get(first.id)).toBeNull(); // the oldest goes once no heard item is left
  });
});
