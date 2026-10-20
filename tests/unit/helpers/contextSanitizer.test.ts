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

  describe("provider key shapes with '_' and '-' in the body", () => {
    // Keys are assembled at runtime so no line in this file reads as a key.
    const keyBody = (length: number) => "Ab3_x-9Q".repeat(Math.ceil(length / 8)).slice(0, length);

    it("redacts a whole OpenAI project key", () => {
      const key = ["sk", "proj", keyBody(156)].join("-");
      expect(sanitizeContextText(`Terminal - ${key} - copied`)).toBe(
        "Terminal - [REDACTED] - copied"
      );
    });

    it("redacts a whole OpenAI service account key", () => {
      const key = ["sk", "svcacct", keyBody(120)].join("-");
      expect(sanitizeContextText(key)).toBe("[REDACTED]");
    });

    it("redacts a whole Anthropic key", () => {
      const key = ["sk", "ant", "api03", `${keyBody(93)}AA`].join("-");
      expect(sanitizeContextText(`Console: ${key}`)).toBe("Console: [REDACTED]");
    });

    it("redacts a whole Groq key", () => {
      const key = ["gsk", keyBody(52)].join("_");
      expect(sanitizeContextText(`Groq key ${key} created`)).toBe(
        "Groq key [REDACTED_GROQ_KEY] created"
      );
    });

    it("redacts a whole Google API key, including a trailing '-'", () => {
      const key = ["AI", "za", keyBody(34), "-"].join("");
      expect(sanitizeContextText(`Maps key ${key} (restricted)`)).toBe(
        "Maps key [REDACTED_GOOGLE_API_KEY] (restricted)"
      );
    });

    it("redacts a key that follows an underscore", () => {
      const key = ["sk", "proj", keyBody(60)].join("-");
      expect(sanitizeContextText(`OPENAI_${key}`)).toBe("OPENAI_[REDACTED]");
    });

    it("leaves words that only contain the prefixes alone", () => {
      const input = "task-management-dashboard-overview and risk-assessment-template-final";
      expect(sanitizeContextText(input)).toBe(input);
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

    it("redacts URL embedded credentials (scheme://user:pass@host)", () => {
      const input = "postgres://db_user:supersecret@localhost:5432/mydb";
      const output = sanitizeContextText(input);
      expect(output).toContain("postgres://db_user:[REDACTED]@localhost:5432/mydb");
      expect(output).not.toContain("supersecret");
    });
  });

  describe("credit card redaction (PAN-like numbers)", () => {
    it("redacts Luhn-valid card numbers (with spaces)", () => {
      // 4242 4242 4242 4242 is a common Stripe test number and Luhn-valid.
      const input = "card: 4242 4242 4242 4242";
      const output = sanitizeContextText(input);
      expect(output).toContain("card: [REDACTED_CARD]");
      expect(output).not.toContain("4242 4242 4242 4242");
    });

    it("does not redact digit sequences that fail Luhn check", () => {
      const input = "id: 1111 1111 1111 1111";
      const output = sanitizeContextText(input);
      expect(output).toBe(input);
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

  describe("secret names and token shapes", () => {
    // Assembled at runtime so no line in this file reads as a key.
    const value = "Zq9Xw2".repeat(6);
    const azureKey = "Ab3x9Q".repeat(14);

    it.each([
      ["JWT_SECRET", `JWT_SECRET=${value}`, "JWT_SECRET=[REDACTED]"],
      ["NPM_TOKEN", `NPM_TOKEN=${value}`, "NPM_TOKEN=[REDACTED]"],
      ["HF_TOKEN", `export HF_TOKEN=${value}`, "export HF_TOKEN=[REDACTED]"],
      [
        "AWS_SECRET_ACCESS_KEY",
        `AWS_SECRET_ACCESS_KEY=${value}`,
        "AWS_SECRET_ACCESS_KEY=[REDACTED]",
      ],
      ["SECRET_KEY", `SECRET_KEY = '${value}'`, "SECRET_KEY = [REDACTED]"],
      ["PRIVATE_KEY", `PRIVATE_KEY=${value}`, "PRIVATE_KEY=[REDACTED]"],
      [
        "a dotted name",
        `spring.datasource.password=${value}`,
        "spring.datasource.password=[REDACTED]",
      ],
      ["a Go assignment", `token := "${value}"`, "token := [REDACTED]"],
      ["a JSON password", '{"password": "hunter two"}', '{"password": [REDACTED]}'],
      ["a JSON token", `{"token":"${value}"}`, '{"token":[REDACTED]}'],
      ["a JSON client secret", `{"client_secret": "${value}"}`, '{"client_secret": [REDACTED]}'],
      [
        "an Azure storage account key",
        `AccountName=acct;AccountKey=${value}+/==;EndpointSuffix=core.windows.net`,
        "AccountName=acct;AccountKey=[REDACTED]",
      ],
      [
        "a JSON Authorization header",
        `"Authorization": "Basic ${value}"`,
        '"Authorization": "Basic [REDACTED]"',
      ],
      [
        "a token after its scheme",
        `X-Auth-Token: Bearer ${value}`,
        "X-Auth-Token: Bearer [REDACTED]",
      ],
      ["a value holding ';' and spaces", "password=hun;ter,2 next", "password=[REDACTED]"],
      [
        "each of two quoted values on their own lines",
        'token: "abc\ntoken: "def',
        "token: [REDACTED]\ntoken: [REDACTED]",
      ],
      [
        "a quote cut off before it closes",
        'password: "hunter two\nnext',
        "password: [REDACTED]\nnext",
      ],
      ["a value with a space", "password: hunter two", "password: [REDACTED]"],
      ["a name after an empty one", "API_KEY: SECRET: hunter2xyz", "API_KEY: [REDACTED]"],
      ["a quoted name after an empty one", "API_KEY: 'SECRET': hunter2xyz", "API_KEY: [REDACTED]"],
      ["a quoted value that holds a name", 'password: "pass: a b c"', "password: [REDACTED]"],
      ["a value that ends in a name", "password: abcpwd= xyz", "password: [REDACTED]"],
    ])("redacts the value of %s", (_name, input, expected) => {
      expect(sanitizeContextText(input)).toBe(expected);
    });

    it.each([
      ["a GitHub OAuth token", ["gho", value].join("_"), "[REDACTED_GITHUB_TOKEN]"],
      ["a GitHub server token", ["ghs", value].join("_"), "[REDACTED_GITHUB_TOKEN]"],
      ["a GitLab token", ["glpat", value].join("-"), "[REDACTED_GITLAB_TOKEN]"],
      ["a Stripe restricted key", ["rk", "live", value].join("_"), "[REDACTED_STRIPE_KEY]"],
      ["an npm token", ["npm", value].join("_"), "[REDACTED_NPM_TOKEN]"],
      ["a Hugging Face token", ["hf", value].join("_"), "[REDACTED_HF_TOKEN]"],
      ["an 84-character Azure key", azureKey, "[REDACTED]"],
      [
        "a Slack webhook",
        ["https://hooks.slack.com", "services", "T0A1", "B0A1", value].join("/"),
        "https://hooks.slack.com/services/[REDACTED]",
      ],
      [
        "a Discord webhook",
        ["https://discord.com/api", "webhooks", "1234567890", value].join("/"),
        "https://discord.com/api/webhooks/[REDACTED]",
      ],
    ])("redacts %s", (_name, token, expected) => {
      expect(sanitizeContextText(`key ${token} copied`)).toBe(`key ${expected} copied`);
    });

    it.each([
      "if (token == null) return;",
      "const trimmed = tokens.map((token) => token.trim());",
      "let parsed = Token::new(source);",
      "max_tokens: 4096",
      "PASSWORD_MIN_LENGTH=8",
    ])("leaves code that only names a secret alone: %s", (input) => {
      expect(sanitizeContextText(input)).toBe(input);
    });

    const megabyteOf = (unit: string) => unit.repeat(Math.ceil((1024 * 1024) / unit.length));

    it.each([
      ["one long name", megabyteOf("a_")],
      ["a run of secret words", megabyteOf("SECRET_TOKEN")],
      ["repeated quoted names", megabyteOf('"token":"')],
      ["repeated assignments", megabyteOf("secret=")],
      ["repeated names with no value", megabyteOf("TOKEN: ")],
      ["repeated quoted names with no value", megabyteOf("'API_KEY': ")],
      ["repeated token prefixes", megabyteOf("glpat-")],
      ["repeated webhook prefixes", megabyteOf("https://hooks.slack.com/services/")],
      ["one long run of letters", megabyteOf("a")],
    ])("redacts 1 MB of %s in well under a second", (_shape, input) => {
      const started = performance.now();
      sanitizeContextText(input, { maxChars: input.length });
      expect(performance.now() - started).toBeLessThan(1000);
    });
  });

  describe("private key blocks", () => {
    // Assembled at runtime so no line in this file reads as a key.
    const line = (...words: string[]) => `-----${words.join(" ")}-----`;
    const body = Array.from({ length: 8 }, () => "MIIEvQIBADANBgkqhkiG9w0BAQEFAASC").join("\n");

    it("redacts a whole block and keeps the text after it", () => {
      const input = `key:\n${line("BEGIN", "RSA", "PRIVATE", "KEY")}\n${body}\n${line("END", "RSA", "PRIVATE", "KEY")}\nnext`;
      expect(sanitizeContextText(input)).toBe("key:\n[REDACTED_PRIVATE_KEY]\nnext");
    });

    it("redacts a PGP private key block", () => {
      const input = `${line("BEGIN", "PGP", "PRIVATE", "KEY", "BLOCK")}\n${body}\n${line("END", "PGP", "PRIVATE", "KEY", "BLOCK")}\nnext`;
      expect(sanitizeContextText(input)).toBe("[REDACTED_PRIVATE_KEY]\nnext");
    });

    it("redacts to the end of the text when the END line is cut off", () => {
      // A focused field is read 512 characters at a time.
      const input = `ssh key ${line("BEGIN", "OPENSSH", "PRIVATE", "KEY")}\n${body}`.slice(0, 200);
      expect(sanitizeContextText(input)).toBe("ssh key [REDACTED_PRIVATE_KEY]");
    });

    const megabyteOf = (unit: string) => unit.repeat(Math.ceil((1024 * 1024) / unit.length));

    it.each([
      ["repeated BEGIN lines", megabyteOf(`${line("BEGIN", "PRIVATE", "KEY")}\n`)],
      ["a BEGIN label repeating PRIVATE KEY", `-----BEGIN ${megabyteOf("PRIVATE KEY ")}`],
      [
        "an END label repeating PRIVATE KEY",
        `${line("BEGIN", "PRIVATE", "KEY")}\n-----END ${megabyteOf("PRIVATE KEY ")}`,
      ],
    ])("redacts 1 MB of %s in well under a second", (_shape, input) => {
      const started = performance.now();
      const output = sanitizeContextText(input, { maxChars: input.length });
      expect(performance.now() - started).toBeLessThan(1000);
      expect(output).not.toContain("BEGIN");
    });
  });

  describe("time on long text", () => {
    // Before the patterns were bounded, 64 KB of "a.a.a." took about 2.5 s and
    // grew with the square of the length. Each now finishes in tens of ms.
    it.each([
      ["a run of short words joined by dots", "a.".repeat(64 * 1024)],
      ["a run of short words joined by hyphens", "a-".repeat(64 * 1024)],
      ["many URLs run together", "http://a".repeat(16 * 1024)],
      ["many schemes run together", "s://a:b".repeat(18 * 1024)],
    ])("redacts %s in well under a second", (_shape, input) => {
      const started = performance.now();
      sanitizeContextText(input, { maxChars: input.length });
      expect(performance.now() - started).toBeLessThan(1000);
    });

    it("still redacts ordinary addresses and URLs", () => {
      expect(
        sanitizeContextText("Mail first.last+tag@mail.example.co.uk about https://ex.com/a?b=1")
      ).toBe("Mail [REDACTED_EMAIL] about https://ex.com/a?[REDACTED_QUERY]");
    });

    it("redacts the query of a URL with a very long path", () => {
      const url = `https://ex.com/${"seg/".repeat(1000)}`;
      expect(sanitizeContextText(`${url}?id=abc123 next`, { maxChars: 10000 })).toBe(
        `${url}?[REDACTED_QUERY] next`
      );
      expect(sanitizeContextText(`${url}#access_token=abc123`, { maxChars: 10000 })).toBe(
        `${url}#[REDACTED_FRAGMENT]`
      );
    });

    it("redacts all of an address with a long local part", () => {
      const local = Array.from({ length: 12 }, (_, i) => `part${i}`).join(".");
      expect(sanitizeContextText(`To ${local}@example.com today`)).toBe(
        "To [REDACTED_EMAIL] today"
      );
    });

    it.each(["-mysql", ".postgres", "+redis", "x_mongodb"])(
      "redacts credentials when %s:// follows punctuation",
      (scheme) => {
        expect(sanitizeContextText(`${scheme}://u:hunter2@db.local`)).toBe(
          `${scheme}://u:[REDACTED]@db.local`
        );
      }
    );

    it("redacts credentials behind a long scheme", () => {
      const scheme = `db${"+driver".repeat(6)}`;
      expect(sanitizeContextText(`${scheme}://admin:hunter2@db.local/app`)).toBe(
        `${scheme}://admin:[REDACTED]@db.local/app`
      );
    });
  });

  describe("truncation", () => {
    it("truncates text exceeding maxChars", () => {
      const input = "zz ".repeat(2000);
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
