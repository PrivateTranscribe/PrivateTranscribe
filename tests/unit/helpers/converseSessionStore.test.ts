import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  readSessionId,
  writeSessionId,
  readStore,
} = require("../../../src/helpers/converseSessionStore");

/**
 * The session store is the only thing standing between "the CLI told us its
 * session id" and "the next app run can resume it", so the cases that matter
 * are the ones where the file is absent, damaged, or being replaced.
 */
describe("converseSessionStore", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-converse-store-"));
    file = path.join(dir, "converse-sessions.json");
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("reads back the id it wrote, keyed by project directory", () => {
    expect(writeSessionId("C:/work/project", "abc-123", file)).toBe(true);
    expect(readSessionId("C:/work/project", file)).toBe("abc-123");
  });

  it("keeps separate ids for separate project directories", () => {
    writeSessionId(path.join(dir, "one"), "id-one", file);
    writeSessionId(path.join(dir, "two"), "id-two", file);

    expect(readSessionId(path.join(dir, "one"), file)).toBe("id-one");
    expect(readSessionId(path.join(dir, "two"), file)).toBe("id-two");
  });

  it("treats the same directory spelled differently as one key", () => {
    writeSessionId(path.join(dir, "proj"), "id-one", file);
    expect(readSessionId(path.join(dir, "sub", "..", "proj"), file)).toBe("id-one");
  });

  it("returns null when nothing has been recorded", () => {
    expect(readSessionId(dir, file)).toBeNull();
    expect(readStore(file)).toEqual({});
  });

  it("survives a corrupt file instead of throwing", () => {
    fs.writeFileSync(file, "{ not json", "utf8");
    expect(readSessionId(dir, file)).toBeNull();

    // And a later write repairs it.
    expect(writeSessionId(dir, "fresh-id", file)).toBe(true);
    expect(readSessionId(dir, file)).toBe("fresh-id");
  });

  it("refuses to record an empty id", () => {
    expect(writeSessionId(dir, "", file)).toBe(false);
    expect(writeSessionId(dir, "   ", file)).toBe(false);
    expect(readSessionId(dir, file)).toBeNull();
  });

  it("leaves no temp file behind after a write", () => {
    writeSessionId(dir, "abc-123", file);
    const leftovers = fs.readdirSync(dir).filter((name) => name.endsWith(".tmp"));
    expect(leftovers).toEqual([]);
  });
});
