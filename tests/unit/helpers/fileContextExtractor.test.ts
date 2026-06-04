import { describe, it, expect } from "vitest";
import path from "path";

const {
  sanitizeFileContent,
  extractFileContext,
} = require("../../../src/helpers/fileContextExtractor");

describe("sanitizeFileContent", () => {
  it("preserves short content", () => {
    const result = sanitizeFileContent("const hello = 'world';", 100);
    expect(result.excerpt).toBe("const hello = 'world';");
    expect(result.truncated).toBe(false);
  });

  it("truncates long content with a note", () => {
    const result = sanitizeFileContent("abcdef", 3);
    expect(result.truncated).toBe(true);
    expect(result.excerpt).toContain("abc");
    expect(result.excerpt).toContain("truncated for prompt size");
  });
});

describe("extractFileContext", () => {
  const rootDir = path.parse(process.cwd()).root;
  const homeDir = path.join(rootDir, "Users", "alice");
  const fsMod = {
    statSync: () => ({ size: 100 }),
    readFileSync: () => "function doThing() {\n  return 42;\n}\n",
  };

  it("returns a safe excerpt for files inside home", () => {
    const result = extractFileContext(path.join(homeDir, "project", "App.ts"), homeDir, fsMod, {
      maxChars: 10,
    });

    expect(result.blocked).toBe(false);
    expect(result.filename).toBe("App.ts");
    expect(result.excerpt).toContain("function d");
    expect(result.truncated).toBe(true);
  });

  it("blocks files outside home", () => {
    const result = extractFileContext(path.join(rootDir, "etc", "passwd"), homeDir, fsMod);
    expect(result.blocked).toBe(true);
    expect(result.reason).toBe("outside home dir");
  });
});
