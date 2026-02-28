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

test("redacts x-api-key header-style assignments", () => {
  const input = "x-api-key: SECRET\nX_API_KEY=SECRET\nxApiKey: SECRET";
  const out = sanitizeContextText(input);
  assert.strictEqual(out.includes("SECRET"), false);
  assert.ok(/x-api-key:\s*\[REDACTED\]/i.test(out));
});

test("redacts common OAuth token fields (access_token / refresh_token / id_token)", () => {
  const input = "access_token=AAA\nrefreshToken: BBB\nid-token: CCC";
  const out = sanitizeContextText(input);
  assert.strictEqual(out.includes("AAA"), false);
  assert.strictEqual(out.includes("BBB"), false);
  assert.strictEqual(out.includes("CCC"), false);
  assert.ok(/access_token=\[REDACTED\]/i.test(out));
});

test("redacts client_secret assignments", () => {
  const input = "client_secret: SUPERSECRET\nclientSecret=SUPERSECRET";
  const out = sanitizeContextText(input);
  assert.strictEqual(out.includes("SUPERSECRET"), false);
  assert.ok(/client_secret:\s*\[REDACTED\]/i.test(out));
});

test("redacts Authorization: Bearer tokens", () => {
  const input = "Authorization: Bearer abc.def.ghi";
  const out = sanitizeContextText(input);
  assert.strictEqual(out.includes("abc.def.ghi"), false);
  assert.ok(/Bearer\s+\[REDACTED\]/i.test(out));
});

test("redacts Authorization: Basic tokens", () => {
  const input = "Authorization: Basic dXNlcjpwYXNz";
  const out = sanitizeContextText(input);
  assert.strictEqual(out.includes("dXNlcjpwYXNz"), false);
  assert.ok(/Basic\s+\[REDACTED\]/i.test(out));
});

test("redacts Proxy-Authorization: Bearer tokens", () => {
  const input = "Proxy-Authorization: Bearer abc.def.ghi";
  const out = sanitizeContextText(input);
  assert.strictEqual(out.includes("abc.def.ghi"), false);
  assert.ok(/Proxy-Authorization:\s*Bearer\s+\[REDACTED\]/i.test(out));
});

test("redacts Proxy-Authorization: Basic tokens", () => {
  const input = "Proxy-Authorization: Basic dXNlcjpwYXNz";
  const out = sanitizeContextText(input);
  assert.strictEqual(out.includes("dXNlcjpwYXNz"), false);
  assert.ok(/Proxy-Authorization:\s*Basic\s+\[REDACTED\]/i.test(out));
});

test("redacts generic Bearer <token> fragments", () => {
  const input = "Fetch failed: Bearer abcdefghijklmnop.qrstuv";
  const out = sanitizeContextText(input);
  assert.strictEqual(out.includes("abcdefghijklmnop.qrstuv"), false);
  assert.ok(/Bearer\s+\[REDACTED\]/i.test(out));
});

test("redacts OpenAI-style sk- keys", () => {
  const input = "sk-abcdefghijklmnopqrstuvwxyz0123456789";
  const out = sanitizeContextText(input);
  assert.strictEqual(out.includes("sk-"), false);
  assert.ok(out.includes("[REDACTED]"));
});

test("redacts Stripe keys (sk_live_/sk_test_/pk_live_/pk_test_)", () => {
  const input = [
    "sk_live_51ABCdefGHIjklMNOpqrSTUvwxYZ1234567890",
    "sk_test_51ABCdefGHIjklMNOpqrSTUvwxYZ1234567890",
    "pk_live_51ABCdefGHIjklMNOpqrSTUvwxYZ1234567890",
    "pk_test_51ABCdefGHIjklMNOpqrSTUvwxYZ1234567890",
  ].join("\n");
  const out = sanitizeContextText(input);
  assert.strictEqual(/\bsk_(?:live|test)_/i.test(out), false);
  assert.strictEqual(/\bpk_(?:live|test)_/i.test(out), false);
  assert.ok(out.includes("[REDACTED_STRIPE_KEY]"));
});

test("redacts Stripe webhook signing secrets (whsec_)", () => {
  const input = "whsec_abcdefghijklmnopqrstuvwxyz0123456789";
  const out = sanitizeContextText(input);
  assert.strictEqual(out.includes("whsec_"), false);
  assert.ok(out.includes("[REDACTED_STRIPE_WEBHOOK_SECRET]"));
});

test("redacts Google API keys (AIza...)", () => {
  const input = "AIzaSyA-0123456789abcdefghijkLMNOPQRSTUV";
  const out = sanitizeContextText(input);
  assert.strictEqual(out.includes("AIza"), false);
  assert.ok(out.includes("[REDACTED_GOOGLE_API_KEY]"));
});

test("redacts Google OAuth access tokens (ya29.)", () => {
  const input = "ya29.a0AfH6SMC1uV4lRzZP6gk8aS8qT9u-0123456789ABCDEFGHIJK";
  const out = sanitizeContextText(input);
  assert.strictEqual(out.includes("ya29."), false);
  assert.ok(out.includes("[REDACTED_GOOGLE_OAUTH_TOKEN]"));
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

test("redacts verification codes (otp/2fa/etc.)", () => {
  const input = "Your verification code: 123456";
  const out = sanitizeContextText(input);
  assert.strictEqual(out.includes("123456"), false);
  assert.ok(/verification code:\s*\[REDACTED_CODE\]/i.test(out));
});

test("redacts likely credit card numbers (Luhn-checked)", () => {
  const input = "card: 4242 4242 4242 4242";
  const out = sanitizeContextText(input);
  assert.strictEqual(out.includes("4242 4242"), false);
  assert.ok(out.includes("[REDACTED_CARD]"));
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
