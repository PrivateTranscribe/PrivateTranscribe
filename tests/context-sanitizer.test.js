"use strict";

const assert = require("assert");

const { sanitizeContextText } = require("../src/helpers/contextSanitizer");

function test(name, fn) {
  try {
    fn();
    process.stdout.write(`✓ ${name}\n`);
  } catch (err) {
    process.stderr.write(`✗ ${name}\n`);
    throw err;
  }
}

test("redacts password assignments (password: / password=)", () => {
  const input = "password: hunter2\npassword=hunter2";
  const out = sanitizeContextText(input);
  assert.strictEqual(out.includes("hunter2"), false);
  assert.ok(out.includes("password: [REDACTED]"));
  assert.ok(out.includes("password=[REDACTED]"));
});

test("redacts apiKey assignments (apiKey / api_key / api-key)", () => {
  const input = "apiKey: SECRET\napi_key=SECRET\napi-key: SECRET";
  const out = sanitizeContextText(input);
  assert.strictEqual(out.includes("SECRET"), false);
});

test("redacts Authorization: Bearer tokens", () => {
  const input = "Authorization: Bearer abc.def.ghi";
  const out = sanitizeContextText(input);
  assert.strictEqual(out.includes("abc.def.ghi"), false);
  assert.ok(/Bearer\s+\[REDACTED\]/i.test(out));
});

test("redacts OpenAI-style sk- keys", () => {
  const input = "sk-abcdefghijklmnopqrstuvwxyz0123456789";
  const out = sanitizeContextText(input);
  assert.strictEqual(out.includes("sk-"), false);
  assert.ok(out.includes("[REDACTED]"));
});

test("redacts JWTs", () => {
  const input = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abcdefABCDEF_-0123456789.zyxwvutsrqponmlkjihgfedcba";
  const out = sanitizeContextText(input);
  assert.strictEqual(out.includes("eyJhbGci"), false);
  assert.ok(out.includes("[REDACTED_JWT]"));
});

test("redacts AWS access key ids (AKIA...)", () => {
  const input = "AKIA1234567890ABCDEF";
  const out = sanitizeContextText(input);
  assert.strictEqual(out.includes("AKIA1234567890ABCDEF"), false);
  assert.ok(out.includes("[REDACTED_AWS_KEY]"));
});

test("redacts GitHub tokens (ghp_ / github_pat_)", () => {
  const input = "token=ghp_abcdefghijklmnopqrstuvwxyzABCDE1234567890\ngithub_pat_ABC_def_1234567890_abcdefghijklmnopqrstuvwxyz";
  const out = sanitizeContextText(input);
  assert.strictEqual(out.includes("ghp_"), false);
  assert.strictEqual(out.includes("github_pat_"), false);
  assert.ok(out.includes("[REDACTED_GITHUB_TOKEN]"));
});

test("redacts Slack tokens (xox*)", () => {
  const input = "xoxb-1234567890-abcdefghijklmnopqrstuvwxyz";
  const out = sanitizeContextText(input);
  assert.strictEqual(out.includes("xoxb-"), false);
  assert.ok(out.includes("[REDACTED_SLACK_TOKEN]"));
});

test("redacts PEM private key blocks", () => {
  const input = [
    "-----BEGIN PRIVATE KEY-----",
    "abcDEF123+/=",
    "-----END PRIVATE KEY-----",
  ].join("\n");
  const out = sanitizeContextText(input);
  assert.strictEqual(out.includes("BEGIN PRIVATE KEY"), false);
  assert.ok(out.includes("[REDACTED_PRIVATE_KEY]"));
});

test("redacts emails", () => {
  const input = "Contact: test.user+foo@example.com";
  const out = sanitizeContextText(input);
  assert.strictEqual(out.includes("example.com"), false);
  assert.ok(out.includes("[REDACTED_EMAIL]"));
});

test("redacts URL query string but keeps base URL", () => {
  const input = "https://example.com/path?token=abc&email=test@example.com";
  const out = sanitizeContextText(input);
  assert.ok(out.includes("https://example.com/path?[REDACTED_QUERY]"));
  assert.strictEqual(out.includes("token="), false);
});

test("redacts long hex tokens (32+ chars)", () => {
  const input = "deadbeefdeadbeefdeadbeefdeadbeef";
  const out = sanitizeContextText(input);
  assert.strictEqual(out.includes("deadbeef"), false);
  assert.ok(out.includes("[REDACTED]"));
});

test("enforces maxChars truncation", () => {
  const input = "a".repeat(100);
  const out = sanitizeContextText(input, { maxChars: 10 });
  assert.strictEqual(out.length, 10);
});

process.stdout.write("All context sanitizer tests passed.\n");
