const { sanitizeContextText } = require("../src/helpers/contextSanitizer");

describe("sanitizeContextText", () => {
  it("redacts common secret fields and tokens", () => {
    const input = [
      "password=hunter2",
      "token: abcdef1234567890",
      "Authorization: Bearer sk-123456789012345678901234567890",
      // 39-ish chars total: AIza + 35 chars
      "api_key=AIza" + "A".repeat(35),
    ].join("\n");

    const out = sanitizeContextText(input);

    expect(out).toContain("password=[REDACTED]");
    expect(out).toContain("token: [REDACTED]");
    expect(out).toContain("Authorization: Bearer [REDACTED]");
    expect(out).toContain("api_key=[REDACTED]");
    expect(out).not.toContain("hunter2");
    expect(out).not.toContain("abcdef1234567890");
  });

  it("redacts emails and query strings", () => {
    const input = "Contact me at kristian@example.com or visit https://example.com?a=1&token=secret";
    const out = sanitizeContextText(input);

    expect(out).toContain("[REDACTED_EMAIL]");
    expect(out).toContain("https://example.com?[REDACTED_QUERY]");
    expect(out).not.toContain("kristian@example.com");
    expect(out).not.toContain("token=secret");
  });

  it("redacts URL credentials", () => {
    const input = "postgres://user:supersecret@localhost:5432/db";
    const out = sanitizeContextText(input);

    expect(out).toContain("postgres://user:[REDACTED]@localhost:5432/db");
    expect(out).not.toContain("supersecret");
  });

  it("truncates to maxChars", () => {
    // Use a non-hex character so we don't trigger longHexToken redaction.
    const input = "x".repeat(200);
    const out = sanitizeContextText(input, { maxChars: 50 });
    expect(out.length).toBe(50);
  });
});
