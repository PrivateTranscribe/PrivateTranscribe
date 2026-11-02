import { describe, expect, it, vi } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { matchCommand } = require("../../../src/helpers/narrator/commands");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { toSpeakable, splitSentences } = require("../../../src/helpers/narrator/spokenText");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  NarratorRewriter,
  parseRewrite,
  templateRewrite,
  buildInput,
} = require("../../../src/helpers/narrator/rewriter");

describe("narrator commands", () => {
  it.each([
    ["Hvad er nyt?", "brief", "da"],
    ["hvad er der nyt", "brief", "da"],
    ["Okay, hvad er nyt?", "brief", "da"],
    ["What's new?", "brief", "en"],
    ["catch me up", "brief", "en"],
    ["Fortæl mere.", "more", "da"],
    ["Tell me more", "more", "en"],
    ["Følg den chat", "follow", "da"],
    ["Follow that chat.", "follow", "en"],
    ["Stop!", "stop", "da"],
    ["be quiet", "stop", "en"],
  ])("hears %j as %s in %s", (text, command, language) => {
    expect(matchCommand(text)).toEqual({ command, language });
  });

  it.each(["I told him that what's new is the build", "ja", "yes", "godkend det", "push it", ""])(
    "does not treat %j as a command",
    (text) => {
      expect(matchCommand(text)).toBeNull();
    }
  );
});

describe("narrator spoken text", () => {
  it("never reads paths, links, file names, code or hashes aloud", () => {
    const spoken = toSpeakable(
      "Fixed `parseLine()` in src/helpers/narrator/router.js and C:\\Users\\x\\a.txt, see https://example.com/pr/1 (commit 4b71005a)."
    );
    expect(spoken).not.toMatch(/router\.js|C:\\|https|4b71005a|parseLine\(\)/);
    expect(spoken).toMatch(/^Fixed/);
  });

  it("keeps plain words in backticks", () => {
    expect(toSpeakable("The `narrator` page")).toBe("The narrator page");
  });

  it("redacts secrets before anything is spoken", () => {
    expect(toSpeakable("Set API_KEY=sk-live-abcdef1234567890 and retry.")).not.toContain("sk-live");
  });

  it("splits sentences without cutting decimals", () => {
    expect(splitSentences("Version 1.5 is out. Next step: test it! Done?")).toEqual([
      "Version 1.5 is out.",
      "Next step: test it!",
      "Done?",
    ]);
  });
});

describe("narrator rewriter", () => {
  it("reads the JSON out of a model reply with text around it", () => {
    expect(
      parseRewrite('Here:\n```json\n{"spoken":"Hej.","card":"Kort","more":"Mere."}\n```')
    ).toEqual({
      spoken: "Hej.",
      card: "Kort",
      more: "Mere.",
    });
    expect(parseRewrite("no json")).toBeNull();
    expect(parseRewrite('{"card":"x"}')).toBeNull();
  });

  it("reads an array for several items and refuses one of the wrong length", () => {
    expect(parseRewrite('[{"spoken":"A."},{"spoken":"B.","card":"b"}]', 2)).toEqual([
      { spoken: "A.", card: "", more: "" },
      { spoken: "B.", card: "b", more: "" },
    ]);
    expect(parseRewrite('[{"spoken":"A."}]', 2)).toBeNull();
  });

  it("asks the model once for a brief, and falls back to templates on a bad reply", async () => {
    const client = {
      warm: vi.fn(),
      close: vi.fn(),
      request: vi.fn(
        async () =>
          '[{"spoken":"Første.","card":"1","more":"m"},{"spoken":"Anden.","card":"2","more":"m"}]'
      ),
    };
    const rewriter = new NarratorRewriter({ client });
    const items = [
      { kind: "finished", chatTitle: "A", recap: "One." },
      { kind: "waiting", chatTitle: "B", ask: "Two?" },
    ];
    const results = await rewriter.rewriteMany(items, "da");
    expect(client.request).toHaveBeenCalledTimes(1);
    expect(results.map((result: { spoken: string }) => result.spoken)).toEqual([
      "Første.",
      "Anden.",
    ]);

    client.request.mockResolvedValueOnce("not json");
    const fallback = await rewriter.rewriteMany(items, "en");
    expect(fallback.map((result: { byModel: boolean }) => result.byModel)).toEqual([false, false]);
    expect(rewriter.lastError).toMatchObject({ code: "bad-reply" });
  });

  it("falls back to a template that leads with the chat and the ask", () => {
    const result = templateRewrite(
      {
        kind: "waiting",
        chatTitle: "Export fix",
        ask: "Push to main?",
        recap: "Fixed. Tests pass.",
      },
      "da"
    );
    expect(result.spoken).toBe("Export fix venter på dig. Push to main?");
    expect(result.byModel).toBe(false);
    expect(
      templateRewrite({ kind: "finished", chatTitle: "", recap: "Done. More." }, "en").spoken
    ).toBe("A chat has finished. Done.");
  });

  it("redacts what it sends to the model", () => {
    expect(
      buildInput({ chatTitle: "x", kind: "finished", recap: "password: hunter2hunter2" })
    ).not.toContain("hunter2");
  });
});
