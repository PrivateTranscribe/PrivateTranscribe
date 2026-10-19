import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

const SOURCE = fs.readFileSync(path.resolve("src", "helpers", "converseSentences.js"), "utf8");

/**
 * Streams `deltas` through a fresh SentenceStream and returns what push() and
 * then flush() emitted. It runs in a vm with a time limit: the splitter runs in
 * the main process, and a list item such as "1. Install it." once sent it into
 * an endless loop that froze the whole app. A regression fails here instead of
 * hanging the suite.
 */
function split(deltas: string[]): { pushed: string[]; flushed: string[] } {
  const sandbox = { module: { exports: {} }, console, deltas, result: "" };
  vm.runInNewContext(
    `${SOURCE}
const stream = new module.exports.SentenceStream();
const pushed = [];
for (const delta of deltas) pushed.push(...stream.push(delta));
result = JSON.stringify({ pushed, flushed: stream.flush() });`,
    sandbox,
    { timeout: 2000 }
  );
  return JSON.parse(sandbox.result);
}

describe("Converse sentence splitter", () => {
  it("keeps a numbered item's number with its text", () => {
    expect(split(["Here are the steps.\n1. Install it.\n2. Run it.\n"])).toEqual({
      pushed: ["Here are the steps.", "1. Install it.", "2. Run it."],
      flushed: [],
    });
  });

  it("keeps a lettered item's letter with its text", () => {
    expect(split(["A. Use the CLI.\nB. Use the app.\n"])).toEqual({
      pushed: ["A. Use the CLI.", "B. Use the app."],
      flushed: [],
    });
  });

  it("holds an unfinished lettered item until the stream ends", () => {
    expect(split(["A. Use the…"])).toEqual({ pushed: [], flushed: ["A. Use the…"] });
  });

  it("still speaks a short fragment the answer ends on", () => {
    expect(split(["Done. A.\n"])).toEqual({ pushed: ["Done."], flushed: ["A."] });
  });

  it("splits a list the same way when it streams in one character at a time", () => {
    const text = "Here are the steps.\n1. Install it.\n2. Run it.\nA. Use the…";
    expect(split(Array.from(text))).toEqual({
      pushed: ["Here are the steps.", "1. Install it.", "2. Run it."],
      flushed: ["A. Use the…"],
    });
  });

  it("still splits ordinary sentences and paragraphs", () => {
    expect(split(["First one. Second one!\n\nA new paragraph? Yes. "])).toEqual({
      pushed: ["First one.", "Second one!", "A new paragraph?", "Yes."],
      flushed: [],
    });
  });
});
