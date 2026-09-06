import { describe, expect, it, vi } from "vitest";
const { readableSpans, splitReadableText } = require("../../../src/helpers/readAloudText");

describe("read aloud text filtering", () => {
  it.each([
    "Pip reached Y=-53, not Y=-48. The test lasted 30 minutes.",
    "Version 0.18.0 costs $12.50 at 10:30 on 2026-09-06.",
    "Call +45 12 34 56 78. The result is 42% and 1,000 units.",
    "C++ and C# are languages. Use snake_case or camelCase names.",
    "Read https://example.com and email me@example.com.",
    "Visit http://x.io for details.",
    "- A short item.\n2. A second item with café and blåbær.",
    "The ordinary prose wraps\nonto the next line without punctuation.",
  ])("preserves normal prose and useful numbers: %s", (text) => {
    expect(readableSpans(text)).toEqual([text]);
  });

  it.each([
    "```js\nconst value = 42;\nconsole.log(value);\n```",
    "~~~~python\ndef helper():\n    return 234\n~~~~",
    "const data = { value: 123 };\nconsole.log(data);",
    '"identifier": "abc123",\n"count": 123\n}',
    "ab12cd34ef56ab78cd90ef12ab34cd56",
    "2695e126-382e-40cd-8552-26377da95c20",
    "aB12cD34eF56gH78iJ90kL12mN34oP56qR78sT90==",
    "123456789012345678901234567890",
    "@@@{{12}}^^&&%%",
  ])("skips code or opaque data without joining across it: %s", (noise) => {
    const text = `Before the example.\n${noise}\nAfter the example.`;
    expect(readableSpans(text)).toEqual(["Before the example.", "After the example."]);
    expect(readableSpans(noise)).toEqual([]);
  });

  it("keeps the source spans on either side of an inline hash", () => {
    const text = "Build ab12cd34ef56ab78cd90ef12ab34cd56 finished successfully.";
    expect(readableSpans(text)).toEqual(["Build", "finished successfully."]);
  });

  it("does not send empty or entirely excluded input to the engine", async () => {
    const split = vi.fn();
    expect(await splitReadableText("```js\nconst x = 123;\n```", split)).toEqual([]);
    expect(await splitReadableText(null, split)).toEqual([]);
    expect(split).not.toHaveBeenCalled();
  });

  it("retains an unterminated fence as code and uses a matching closing fence", () => {
    expect(readableSpans("Read this.\n```\nconst x = 1;\n~~~\nMore code")).toEqual(["Read this."]);
  });

  it("passes each source span through the existing sentence splitter", async () => {
    const split = vi.fn(async (text) => [text]);
    expect(await splitReadableText("Before.\n```\nx = 1\n```\nAfter.", split)).toEqual([
      "Before.",
      "After.",
    ]);
    expect(split.mock.calls).toEqual([["Before."], ["After."]]);
  });
});
