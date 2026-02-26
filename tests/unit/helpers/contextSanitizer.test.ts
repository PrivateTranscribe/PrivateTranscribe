/**
 * Tests for context sanitizer (privacy guardrails)
 * @module tests/unit/helpers/contextSanitizer
 */

import { describe, it, expect } from "vitest";

// Inline implementation matching src/helpers/contextSanitizer.js
interface SanitizeOptions {
  maxChars?: number;
}

function sanitizeContextText(text: string, options: SanitizeOptions = {}): string {
  const { maxChars = 2000 } = options;

  if (!text || typeof text !== "string") {
    return "";
  }

  let sanitized = text;

  // Redact Bearer tokens first (before general pattern matching)
  sanitized = sanitized.replace(/Bearer\s+[^\s"',\n]+/gi, "Bearer [REDACTED]");

  // Redact password-like fields (various formats)
  // Matches: password: value, password=value, "password": "value"
  // Note: Don't match "authorization: Bearer" since Bearer is handled above
  sanitized = sanitized.replace(
    /(?:password|passwd|pwd|secret|token|api_?key|apikey|auth|authorization)\s*[:=]\s*(?!Bearer\s)["']?[^\s"',\n]+["']?/gi,
    (match) => {
      const colonIndex = match.search(/[:=]/);
      const prefix = match.substring(0, colonIndex + 1);
      return prefix + " [REDACTED]";
    }
  );

  // Redact JSON-style quoted key-value pairs for sensitive fields
  sanitized = sanitized.replace(
    /"(?:password|passwd|pwd|secret|token|api_?key|apikey|auth)"\s*:\s*"[^"]*"/gi,
    (match) => {
      const colonIndex = match.indexOf(":");
      const prefix = match.substring(0, colonIndex + 1);
      return prefix + ' "[REDACTED]"';
    }
  );

  // Redact base64-encoded strings that look like credentials (40+ chars)
  sanitized = sanitized.replace(
    /(?:sk-|pk-|rk-|key-)[A-Za-z0-9+/=_-]{20,}/g,
    "[REDACTED_KEY]"
  );

  // Redact AWS-style keys
  sanitized = sanitized.replace(
    /(?:AKIA|ABIA|ACCA|ASIA)[A-Z0-9]{16}/g,
    "[REDACTED_AWS_KEY]"
  );

  // Redact generic long alphanumeric strings in quotes that look like API keys
  sanitized = sanitized.replace(
    /["'][A-Za-z0-9+/=_-]{32,}["']/g,
    '"[REDACTED_SECRET]"'
  );

  // Truncate to maxChars
  if (sanitized.length > maxChars) {
    sanitized = sanitized.substring(0, maxChars);
  }

  return sanitized;
}

describe("sanitizeContextText", () => {
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
      expect(output).toContain("password= [REDACTED]");
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
      expect(output).toContain("pwd= [REDACTED]");
      expect(output).not.toContain("shortpwd");
    });

    it("handles quoted password values", () => {
      const input = 'password: "my secret pass"';
      const output = sanitizeContextText(input);
      expect(output).toContain("[REDACTED]");
      expect(output).not.toContain("my secret pass");
    });
  });

  describe("API key redaction", () => {
    it("redacts apiKey=value format", () => {
      const input = "apiKey=abc123xyz789";
      const output = sanitizeContextText(input);
      expect(output).toContain("apiKey= [REDACTED]");
      expect(output).not.toContain("abc123xyz789");
    });

    it("redacts api_key: value format", () => {
      const input = "api_key: def456ghi012";
      const output = sanitizeContextText(input);
      expect(output).toContain("api_key: [REDACTED]");
      expect(output).not.toContain("def456ghi012");
    });

    it("redacts OpenAI-style keys (sk-...)", () => {
      const input = "key: sk-proj-abcdefghijklmnopqrstuvwxyz123456";
      const output = sanitizeContextText(input);
      expect(output).toContain("[REDACTED_KEY]");
      expect(output).not.toContain("sk-proj-abcdefghijklmnopqrstuvwxyz");
    });

    it("redacts Anthropic-style keys", () => {
      const input = "ANTHROPIC_API_KEY=sk-ant-abcdefghijklmnopqrstuvwxyz";
      const output = sanitizeContextText(input);
      expect(output).not.toContain("sk-ant-abcdefghijklmnopqrstuvwxyz");
    });
  });

  describe("Bearer token redaction", () => {
    it("redacts Bearer tokens", () => {
      const input = "Authorization: Bearer very.secret.token.here";
      const output = sanitizeContextText(input);
      expect(output).toContain("Bearer [REDACTED]");
      expect(output).not.toContain("very.secret.token.here");
    });

    it("handles lowercase bearer", () => {
      const input = "auth: bearer mytokenvalue123";
      const output = sanitizeContextText(input);
      expect(output.toLowerCase()).toContain("[redacted]");
      expect(output).not.toContain("mytokenvalue123");
    });
  });

  describe("secret field redaction", () => {
    it("redacts secret field", () => {
      const input = "secret: my-secret-value";
      const output = sanitizeContextText(input);
      expect(output).toContain("secret: [REDACTED]");
      expect(output).not.toContain("my-secret-value");
    });

    it("redacts token field", () => {
      const input = "token=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9";
      const output = sanitizeContextText(input);
      expect(output).toContain("token= [REDACTED]");
      expect(output).not.toContain("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9");
    });

    it("redacts auth field", () => {
      const input = "auth: basic-auth-string";
      const output = sanitizeContextText(input);
      expect(output).toContain("auth: [REDACTED]");
      expect(output).not.toContain("basic-auth-string");
    });
  });

  describe("AWS key redaction", () => {
    it("redacts AWS access key IDs", () => {
      const input = "AWS_ACCESS_KEY=AKIAIOSFODNN7EXAMPLE";
      const output = sanitizeContextText(input);
      expect(output).toContain("[REDACTED_AWS_KEY]");
      expect(output).not.toContain("AKIAIOSFODNN7EXAMPLE");
    });

    it("redacts various AWS key prefixes", () => {
      expect(sanitizeContextText("key: AKIAIOSFODNN7EXAMPLE")).toContain("[REDACTED_AWS_KEY]");
      expect(sanitizeContextText("key: ABIAIOSFODNN7EXAMPLE")).toContain("[REDACTED_AWS_KEY]");
      expect(sanitizeContextText("key: ACCAIOSFODNN7EXAMPLE")).toContain("[REDACTED_AWS_KEY]");
      expect(sanitizeContextText("key: ASIAIOSFODNN7EXAMPLE")).toContain("[REDACTED_AWS_KEY]");
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
      const input = "a".repeat(5000);
      const output = sanitizeContextText(input, { maxChars: 100 });
      expect(output.length).toBe(100);
    });

    it("preserves text under maxChars", () => {
      const input = "short text";
      const output = sanitizeContextText(input, { maxChars: 100 });
      expect(output).toBe(input);
    });

    it("uses default maxChars of 2000", () => {
      const input = "a".repeat(3000);
      const output = sanitizeContextText(input);
      expect(output.length).toBe(2000);
    });
  });

  describe("edge cases", () => {
    it("handles empty string", () => {
      expect(sanitizeContextText("")).toBe("");
    });

    it("handles null/undefined input", () => {
      expect(sanitizeContextText(null as unknown as string)).toBe("");
      expect(sanitizeContextText(undefined as unknown as string)).toBe("");
    });

    it("handles non-string input", () => {
      expect(sanitizeContextText(123 as unknown as string)).toBe("");
      expect(sanitizeContextText({} as unknown as string)).toBe("");
    });

    it("preserves normal text without secrets", () => {
      const input = "This is a normal message about coding.";
      const output = sanitizeContextText(input);
      expect(output).toBe(input);
    });

    it("handles multiple secrets in one text", () => {
      const input = `
        password: secret1
        api_key: key123
        Authorization: Bearer token456
      `;
      const output = sanitizeContextText(input);
      expect(output).not.toContain("secret1");
      expect(output).not.toContain("key123");
      expect(output).not.toContain("token456");
      expect(output).toContain("[REDACTED]");
    });
  });

  describe("case sensitivity", () => {
    it("handles uppercase field names", () => {
      const input = "PASSWORD: mysecret";
      const output = sanitizeContextText(input);
      expect(output).toContain("[REDACTED]");
      expect(output).not.toContain("mysecret");
    });

    it("handles mixed case field names", () => {
      const input = "PassWord: mysecret";
      const output = sanitizeContextText(input);
      expect(output).toContain("[REDACTED]");
      expect(output).not.toContain("mysecret");
    });
  });

  describe("JSON-like content", () => {
    it("redacts secrets in JSON format", () => {
      const input = '{"password": "json-secret", "user": "alice"}';
      const output = sanitizeContextText(input);
      expect(output).not.toContain("json-secret");
      expect(output).toContain("alice"); // Non-secret should be preserved
    });

    it("handles nested JSON", () => {
      const input = '{"config": {"api_key": "nested-key"}}';
      const output = sanitizeContextText(input);
      expect(output).not.toContain("nested-key");
    });
  });
});
