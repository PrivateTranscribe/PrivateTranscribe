import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const {
  ALLOWED_ANALYTICS_EVENTS,
  ALLOWED_ANALYTICS_PROPERTY_KEYS,
  isAllowedAnalyticsEvent,
  sanitizeAnalyticsProperties,
} = require("../../../src/helpers/analyticsPayload.js") as {
  ALLOWED_ANALYTICS_EVENTS: Set<string>;
  ALLOWED_ANALYTICS_PROPERTY_KEYS: Set<string>;
  isAllowedAnalyticsEvent: (event: unknown) => boolean;
  sanitizeAnalyticsProperties: (properties: unknown) => Record<string, unknown>;
};

describe("analytics payload privacy", () => {
  it("keeps only allowlisted aggregate properties", () => {
    const sanitized = sanitizeAnalyticsProperties({
      source: "local",
      output_action: "paste",
      word_count_bucket: "11-50",
      duration_bucket: "6-15s",
      transcript: "private dictated content",
      window_title: "Confidential client matter",
      filename: "secret.txt",
      nested: { text: "private" },
    });

    expect(sanitized).toEqual({
      source: "local",
      output_action: "paste",
      word_count_bucket: "11-50",
      duration_bucket: "6-15s",
    });
    expect(JSON.stringify(sanitized)).not.toContain("private dictated content");
    expect(JSON.stringify(sanitized)).not.toContain("Confidential client matter");
    expect(JSON.stringify(sanitized)).not.toContain("secret.txt");
  });

  it("rejects unknown events and unsupported property values", () => {
    expect(isAllowedAnalyticsEvent("transcription_completed")).toBe(true);
    expect(isAllowedAnalyticsEvent("transcript_uploaded")).toBe(false);
    expect(sanitizeAnalyticsProperties({ step: Number.POSITIVE_INFINITY })).toEqual({});
    expect(sanitizeAnalyticsProperties(["not", "an", "object"])).toEqual({});
  });

  it("keeps the client and database allowlists aligned", () => {
    const migration = fs.readFileSync(
      path.join(
        process.cwd(),
        "supabase",
        "migrations",
        "20260724233322_add_usage_event_properties.sql"
      ),
      "utf8"
    );

    for (const event of ALLOWED_ANALYTICS_EVENTS) {
      expect(migration).toContain(`'${event}'`);
    }
    for (const property of ALLOWED_ANALYTICS_PROPERTY_KEYS) {
      expect(migration).toContain(`'${property}'`);
    }
    expect(migration).toContain("revoke all privileges");
    expect(migration).toContain("grant insert on table public.usage_events to anon");
  });
});
