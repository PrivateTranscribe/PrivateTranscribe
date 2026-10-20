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

describe("secrets in the file excerpt", () => {
  const rootDir = path.parse(process.cwd()).root;
  const homeDir = path.join(rootDir, "Users", "alice");
  // Assembled at runtime so no line in this file reads as a key.
  const keyBody = "Ab3_x-9Q".repeat(20);
  const openAiKey = ["sk", "proj", keyBody].join("-");
  const groqKey = ["gsk", keyBody.slice(0, 52)].join("_");

  /** The excerpt the AI prompt would get for a file holding `content`. */
  const excerptOf = (content: string, maxChars?: number) =>
    extractFileContext(
      path.join(homeDir, "privoca", "config.ts"),
      homeDir,
      { statSync: () => ({ size: content.length }), readFileSync: () => content },
      maxChars ? { maxChars } : {}
    ).excerpt as string;

  it("redacts a key in the file the way the window context does", () => {
    const content = [
      `const openai = "${openAiKey}";`,
      `export const groq = ${groqKey};`,
      "const password = hunter2;",
    ].join("\n");

    const excerpt = excerptOf(content);

    expect(excerpt).not.toContain(keyBody.slice(0, 40));
    expect(excerpt).not.toContain("hunter2");
    expect(excerpt).toContain("const openai =");
    expect(excerpt).toContain("[REDACTED_GROQ_KEY]");
  });

  it("redacts a private key block that crosses the cut", () => {
    const begin = ["-----BEGIN", "PRIVATE", "KEY-----"].join(" ");
    const end = ["-----END", "PRIVATE", "KEY-----"].join(" ");
    const keyLines = Array.from({ length: 20 }, () => "MIIEvQIBADANBgkqhkiG9w0BAQEFAASC").join(
      "\n"
    );
    const content = `${"x".repeat(3900)}\n${begin}\n${keyLines}\n${end}\n`;

    const excerpt = excerptOf(content, 4000);

    expect(excerpt).not.toContain("MIIEvQIBADAN");
    expect(excerpt).toContain("[REDACTED_PRIVATE_KEY]");
  });

  it("redacts only what can reach the excerpt, so a 500 KB file stays quick", () => {
    // Text that slows a regex-based redactor most, at the largest size read.
    const content = `const openai = "${openAiKey}";\n${"a.".repeat(240 * 1024)}`;

    const started = performance.now();
    const excerpt = excerptOf(content);
    const elapsedMs = performance.now() - started;

    expect(elapsedMs).toBeLessThan(500);
    expect(excerpt).not.toContain(keyBody.slice(0, 40));
    expect(excerpt).toContain("truncated for prompt size");
  });
});
