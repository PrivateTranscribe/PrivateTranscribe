import { describe, it, expect, vi } from "vitest";
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

describe("credentials files", () => {
  const { extractFromFilePath } = require("../../../src/helpers/fileIdentifierExtractor");
  const rootDir = path.parse(process.cwd()).root;
  const homeDir = path.join(rootDir, "Users", "alice");

  it.each([
    ".env",
    ".env.local",
    "prod.env",
    "server.pem",
    "tls.key",
    "id_rsa",
    "id_ed25519",
    "credentials.json",
    "client_secret.json",
    "secrets.yaml",
    "prod.tfvars",
    "cert.pfx",
    ".npmrc",
    "secrets.ts",
    "aws-credentials.ts",
    "local_secrets.py",
    "secretManager.json",
    "secretKey.ts",
    "secretConfig.ts",
    "credentialsLocal.ts",
  ])("reads nothing from %s", (name) => {
    const fsMod = {
      statSync: () => ({ size: 10 }),
      readFileSync: vi.fn(() => "KEY=value"),
    };
    const filePath = path.join(homeDir, "privoca", name);

    expect(extractFileContext(filePath, homeDir, fsMod)).toEqual({
      blocked: true,
      reason: "credentials file",
    });
    expect(extractFromFilePath(filePath, homeDir, fsMod)).toMatchObject({
      blocked: true,
      reason: "credentials file",
    });
    expect(fsMod.readFileSync).not.toHaveBeenCalled();
  });

  it.each([
    "environment.ts",
    "envelope.js",
    "keyboard.ts",
    "App.jsx",
    "tokens.css",
    "secretManager.ts",
    "SecretsPanel.tsx",
    "CredentialProvider.cs",
  ])("still reads %s", (name) => {
    const fsMod = { statSync: () => ({ size: 10 }), readFileSync: () => "const a = 1;" };
    const result = extractFileContext(path.join(homeDir, "privoca", name), homeDir, fsMod);
    expect(result).toMatchObject({ blocked: false, excerpt: "const a = 1;" });
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

  describe("a value crossing the end of the scanned part", () => {
    // 4,000 characters of excerpt and 16 KB past it are scanned.
    const SCAN_END = 4000 + 16 * 1024;
    const begin = ["-----BEGIN", "RSA", "PRIVATE", "KEY-----"].join(" ");
    const end = ["-----END", "RSA", "PRIVATE", "KEY-----"].join(" ");
    const keyLines = Array.from(
      { length: 50 },
      (_, i) => `MIIJKAIBAAKCAgEA${String(i).padStart(2, "0")}${"x".repeat(46)}`
    ).join("\n");
    const privateKey = `${begin}\n${keyLines}\n${end}\n`;

    it("keeps a private key out when a long cookie line shortens the text before it", () => {
      const cookieLine = `cookie: ${"c".repeat(17500)}\n`;
      const filler = `${"y".repeat(SCAN_END - cookieLine.length - 1001)}\n`;
      const content = `${cookieLine}${filler}${privateKey}tail\n`;
      expect(content.indexOf(begin)).toBeLessThan(SCAN_END);
      expect(content.indexOf(end)).toBeGreaterThan(SCAN_END);

      const excerpt = excerptOf(content, 4000);

      expect(excerpt).not.toContain("MIIJKAIBAAKCAgEA");
      expect(excerpt).not.toContain(begin);
    });

    it("keeps the next key out of a file of private keys", () => {
      const excerpt = excerptOf(privateKey.repeat(8), 4000);

      expect(excerpt).not.toContain("MIIJKAIBAAKCAgEA");
      expect(excerpt).toContain("[REDACTED_PRIVATE_KEY]");
    });

    it("keeps a long token cut off by the end of the scan out of the excerpt", () => {
      // Fourteen long hashes shrink to markers and pull the token into the
      // excerpt. Its 6 KB second part runs past the end of the scan.
      const hashes = `${"a".repeat(1000)}\n`.repeat(14);
      const tokenStart = 14500;
      const token = ["eyJ" + "h".repeat(30), "eyJ" + "p".repeat(6000), "s".repeat(43)].join(".");
      const content = `${hashes}${"y".repeat(tokenStart - hashes.length - 1)}\n${token}\n`;
      expect(content.indexOf(token)).toBe(tokenStart);
      expect(tokenStart + token.length).toBeGreaterThan(SCAN_END);

      const excerpt = excerptOf(content, 4000);

      expect(excerpt).not.toContain("eyJhhhhh");
      expect(excerpt).toContain("[REDACTED]\n");
    });
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
