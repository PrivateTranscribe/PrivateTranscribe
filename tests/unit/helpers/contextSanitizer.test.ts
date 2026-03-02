/**
 * Tests for context sanitizer (privacy guardrails)
 * @module tests/unit/helpers/contextSanitizer
 */

import { describe, it, expect } from "vitest";

// The real implementation lives in JS (CommonJS). Use require to avoid TS/ESM interop pain.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { sanitizeContextText } = require("../../../src/helpers/contextSanitizer.js") as {
  sanitizeContextText: (text: string, options?: { maxChars?: number }) => string;
};

describe("sanitizeContextText (real implementation)", () => {
  describe("password field redaction", () => {
    it("redacts password: value format", () => {
      const input = "username: alice\npassword: hunter2\n";
      const output = sanitizeContextText(input);
      expect(output).toContain("password: [REDACTED]");
      expect(output).not.toContain("hunter2");
    });

    it("redacts password=value format", () => {
      const input = "password=supersecret123";
      const output = sanitizeContextText(input);
      expect(output).toContain("password=[REDACTED]");
      expect(output).not.toContain("supersecret123");
    });

    it("redacts passwd field", () => {
      const input = "passwd: mypassword";
      const output = sanitizeContextText(input);
      expect(output).toContain("passwd: [REDACTED]");
      expect(output).not.toContain("mypassword");
    });

    it("redacts pwd field", () => {
      const input = "pwd=shortpwd";
      const output = sanitizeContextText(input);
      expect(output).toContain("pwd=[REDACTED]");
      expect(output).not.toContain("shortpwd");
    });

    it("handles quoted password values (including spaces)", () => {
      const input = 'password: "my secret pass"';
      const output = sanitizeContextText(input);
      expect(output).toContain("password: [REDACTED]");
      expect(output).not.toContain("my secret pass");
    });
  });

  describe("API key redaction", () => {
    it("redacts apiKey=value format", () => {
      const input = "apiKey=abc123xyz789";
      const output = sanitizeContextText(input);
      expect(output).toContain("apiKey=[REDACTED]");
      expect(output).not.toContain("abc123xyz789");
    });

    it("redacts api_key: value format", () => {
      const input = "api_key: def456ghi012";
      const output = sanitizeContextText(input);
      expect(output).toContain("api_key: [REDACTED]");
      expect(output).not.toContain("def456ghi012");
    });

    it("redacts OpenAI/Anthropic-style keys (sk-...)", () => {
      const input = "key: sk-proj-abcdefghijklmnopqrstuvwxyz123456";
      const output = sanitizeContextText(input);
      expect(output).toContain("[REDACTED]");
      expect(output).not.toContain("sk-proj-abcdefghijklmnopqrstuvwxyz123456");
    });
  });

  describe("Bearer token redaction", () => {
    it("redacts Authorization: Bearer tokens", () => {
      const input = "Authorization: Bearer very.secret.token.here";
      const output = sanitizeContextText(input);
      expect(output).toContain("Bearer [REDACTED]");
      expect(output).not.toContain("very.secret.token.here");
    });

    it("handles lowercase bearer", () => {
      const input = "authorization: bearer mytokenvalue123";
      const output = sanitizeContextText(input);
      expect(output.toLowerCase()).toContain("bearer [redacted]");
      expect(output).not.toContain("mytokenvalue123");
    });
  });

  describe("secret/token field redaction", () => {
    it("redacts secret field", () => {
      const input = "secret: my-secret-value";
      const output = sanitizeContextText(input);
      expect(output).toContain("secret: [REDACTED]");
      expect(output).not.toContain("my-secret-value");
    });

    it("redacts token field", () => {
      const input = "token=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9";
      const output = sanitizeContextText(input);
      expect(output).toContain("token=[REDACTED]");
      expect(output).not.toContain("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9");
    });

    it("redacts authorization_code fields", () => {
      const input = "authorization_code=abc123xyz";
      const output = sanitizeContextText(input);
      expect(output).toContain("authorization_code=[REDACTED]");
      expect(output).not.toContain("abc123xyz");
    });

    it("redacts oauth code phrases", () => {
      const input = "oauth code: 9f1a2b3c4d";
      const output = sanitizeContextText(input);
      expect(output).toContain("oauth code: [REDACTED]");
      expect(output).not.toContain("9f1a2b3c4d");
    });
  });

  describe("phone number redaction", () => {
    it("redacts phone: field", () => {
      const input = "phone: +45 12 34 56 78";
      const output = sanitizeContextText(input);
      expect(output).toContain("phone: [REDACTED_PHONE]");
      expect(output).not.toContain("+45");
      expect(output).not.toContain("12345678");
    });

    it("redacts tel= field", () => {
      const input = "tel=+1 (555) 123-4567";
      const output = sanitizeContextText(input);
      expect(output).toContain("tel=[REDACTED_PHONE]");
      expect(output).not.toContain("555");
    });
  });

  describe("national ID / SSN redaction", () => {
    it("redacts cpr: field (DK CPR format)", () => {
      const input = "cpr: 010203-1234";
      const output = sanitizeContextText(input);
      expect(output).toContain("cpr: [REDACTED_NATIONAL_ID]");
      expect(output).not.toContain("010203-1234");
    });

    it("redacts ssn= field", () => {
      const input = "ssn=123-45-6789";
      const output = sanitizeContextText(input);
      expect(output).toContain("ssn=[REDACTED_NATIONAL_ID]");
      expect(output).not.toContain("123-45-6789");
    });
  });

  describe("AWS key redaction", () => {
    it("redacts AWS access key IDs (multiple prefixes)", () => {
      expect(sanitizeContextText("key: AKIAIOSFODNN7EXAMPLE")).toContain("[REDACTED_AWS_KEY]");
      expect(sanitizeContextText("key: ABIAIOSFODNN7EXAMPLE")).toContain("[REDACTED_AWS_KEY]");
      expect(sanitizeContextText("key: ACCAIOSFODNN7EXAMPLE")).toContain("[REDACTED_AWS_KEY]");
      expect(sanitizeContextText("key: ASIAIOSFODNN7EXAMPLE")).toContain("[REDACTED_AWS_KEY]");
    });
  });

  describe("URL redaction", () => {
    it("redacts URL query strings", () => {
      const input = "See https://example.com/callback?token=abc123&state=xyz";
      const output = sanitizeContextText(input);
      expect(output).toContain("https://example.com/callback?[REDACTED_QUERY]");
      expect(output).not.toContain("token=abc123");
      expect(output).not.toContain("state=xyz");
    });

    it("redacts URL fragments", () => {
      const input = "See https://example.com/callback#access_token=abc123&token_type=bearer";
      const output = sanitizeContextText(input);
      expect(output).toContain("https://example.com/callback#[REDACTED_FRAGMENT]");
      expect(output).not.toContain("access_token=abc123");
      expect(output).not.toContain("token_type=bearer");
    });
  });

  describe("long secret redaction", () => {
    it("redacts long quoted strings that look like secrets", () => {
      const input = '"abcdefghijklmnopqrstuvwxyz1234567890ABCD"';
      const output = sanitizeContextText(input);
      expect(output).toContain("[REDACTED_SECRET]");
    });

    it("preserves short quoted strings", () => {
      const input = '"short string"';
      const output = sanitizeContextText(input);
      expect(output).toBe(input);
    });
  });

  describe("truncation", () => {
    it("truncates text exceeding maxChars", () => {
      const input = "z".repeat(5000);
      const output = sanitizeContextText(input, { maxChars: 100 });
      expect(output.length).toBe(100);
    });

    it("preserves text under maxChars", () => {
      const input = "short text";
      const output = sanitizeContextText(input, { maxChars: 100 });
      expect(output).toBe(input);
    });
  });

  describe("edge cases", () => {
    it("handles empty string", () => {
      expect(sanitizeContextText("")).toBe("");
    });

    it("handles null/undefined/non-string input", () => {
      expect(sanitizeContextText(null as unknown as string)).toBe("");
      expect(sanitizeContextText(undefined as unknown as string)).toBe("");
      expect(sanitizeContextText(123 as unknown as string)).toBe("");
      expect(sanitizeContextText({} as unknown as string)).toBe("");
    });

    it("preserves normal text without secrets", () => {
      const input = "This is a normal message about coding.";
      const output = sanitizeContextText(input);
      expect(output).toBe(input);
    });
  });
});
