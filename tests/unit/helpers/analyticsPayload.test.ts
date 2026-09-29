import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ALLOWED_TRANSCRIPTION_ANALYTICS_LANGUAGES,
  ALLOWED_TRANSCRIPTION_ANALYTICS_SOURCES,
} from "../../../src/utils/analytics";
import { privateFile } from "../../privateCheckout";

const require = createRequire(import.meta.url);
const migrationsDir = privateFile("supabase", "migrations");
const {
  ALLOWED_ANALYTICS_EVENTS,
  ALLOWED_ANALYTICS_LANGUAGES,
  ALLOWED_ANALYTICS_MODELS,
  ALLOWED_ANALYTICS_PROPERTY_KEYS,
  ALLOWED_ANALYTICS_SOURCES,
  isAllowedAnalyticsEvent,
  sanitizeAnalyticsProperties,
} = require("../../../src/helpers/analyticsPayload.js") as {
  ALLOWED_ANALYTICS_EVENTS: Set<string>;
  ALLOWED_ANALYTICS_LANGUAGES: Set<string>;
  ALLOWED_ANALYTICS_MODELS: Set<string>;
  ALLOWED_ANALYTICS_PROPERTY_KEYS: Set<string>;
  ALLOWED_ANALYTICS_SOURCES: Set<string>;
  isAllowedAnalyticsEvent: (event: unknown) => boolean;
  sanitizeAnalyticsProperties: (properties: unknown) => Record<string, unknown>;
};

describe("analytics payload privacy", () => {
  it("keeps only allowlisted aggregate and performance properties", () => {
    const sanitized = sanitizeAnalyticsProperties({
      source: "local",
      output_action: "paste",
      word_count_bucket: "11-50",
      duration_bucket: "6-15s",
      language: "da",
      model: "turbo",
      compute_mode: "cuda",
      realtime_factor_x100: 3000,
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
      language: "da",
      model: "turbo",
      compute_mode: "cuda",
      realtime_factor_x100: 3000,
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

  it("rejects free-form text and out-of-range values inside allowlisted fields", () => {
    expect(
      sanitizeAnalyticsProperties({
        source: "Confidential client matter",
        output_action: "email transcript",
        word_count_bucket: "the entire transcript",
        step: 1.5,
        step_count: -1,
        compute_mode: "rtx-4090",
        realtime_factor_x100: 0,
      })
    ).toEqual({ source: "unknown" });

    expect(
      sanitizeAnalyticsProperties({
        source: "local-parakeet",
        output_action: "paste",
        step: 2,
        step_count: 5,
        compute_mode: "cpu",
        realtime_factor_x100: 11525,
      })
    ).toEqual({
      source: "local-parakeet",
      output_action: "paste",
      step: 2,
      step_count: 5,
      compute_mode: "cpu",
      realtime_factor_x100: 11525,
    });
  });

  it("no longer sends the events and counts of the old daily word cap", () => {
    for (const event of [
      "starter_words_used",
      "starter_limit_reached",
      "starter_limit_hit",
      "starter_file_words_used",
    ]) {
      expect(isAllowedAnalyticsEvent(event)).toBe(false);
    }
    expect(
      sanitizeAnalyticsProperties({
        words_added: 3,
        words_used: 5000,
        daily_limit: 1000,
        limit_reached: true,
      })
    ).toEqual({});
  });

  it("categorizes arbitrary language and model strings at the main-process boundary", () => {
    expect(
      sanitizeAnalyticsProperties({
        source: "secret-project-codename",
        language: "secret-project",
        model: "acme-private-model-v7",
      })
    ).toEqual({ source: "unknown", language: "custom", model: "custom" });
  });

  it("keeps semantic analytics enums aligned with selectable settings", async () => {
    const { LANGUAGE_OPTIONS } = await import("../../../src/utils/languages");
    const registry = JSON.parse(
      fs.readFileSync(path.join(process.cwd(), "src", "models", "modelRegistryData.json"), "utf8")
    );
    const modelIds = [
      ...Object.keys(registry.whisperModels),
      ...Object.keys(registry.parakeetModels),
      ...registry.transcriptionProviders.flatMap((provider: { models: Array<{ id: string }> }) =>
        provider.models.map((model) => model.id)
      ),
    ];

    for (const { value } of LANGUAGE_OPTIONS) {
      expect(ALLOWED_ANALYTICS_LANGUAGES).toContain(value);
    }
    expect(ALLOWED_ANALYTICS_LANGUAGES).toContain("unset");
    for (const modelId of modelIds) {
      expect(ALLOWED_ANALYTICS_MODELS).toContain(modelId);
    }
    expect(ALLOWED_ANALYTICS_MODELS).toContain("custom");
    expect(ALLOWED_ANALYTICS_MODELS).toContain("unknown");
    expect(ALLOWED_ANALYTICS_SOURCES).toContain("local");
    expect(ALLOWED_ANALYTICS_SOURCES).toContain("openai");
    expect(ALLOWED_ANALYTICS_SOURCES).toContain("openai-reasoned");
    expect(ALLOWED_ANALYTICS_SOURCES).toContain("unknown");
    expect([...ALLOWED_TRANSCRIPTION_ANALYTICS_LANGUAGES].sort()).toEqual(
      [...ALLOWED_ANALYTICS_LANGUAGES].sort()
    );
    expect([...ALLOWED_TRANSCRIPTION_ANALYTICS_SOURCES].sort()).toEqual(
      [...ALLOWED_ANALYTICS_SOURCES].sort()
    );
  });

  it.skipIf(!migrationsDir)("keeps the client and database allowlists aligned", () => {
    const migrations = fs
      .readdirSync(migrationsDir!)
      .filter((name) => name.endsWith(".sql"))
      .sort()
      .map((name) => fs.readFileSync(path.join(migrationsDir!, name), "utf8"))
      .join("\n");
    const performanceMigration = fs.readFileSync(
      path.join(migrationsDir!, "20260823160000_add_transcription_performance_analytics.sql"),
      "utf8"
    );

    for (const event of ALLOWED_ANALYTICS_EVENTS) {
      expect(migrations).toContain(`'${event}'`);
    }
    for (const property of ALLOWED_ANALYTICS_PROPERTY_KEYS) {
      expect(migrations).toContain(`'${property}'`);
    }
    for (const value of [...ALLOWED_ANALYTICS_LANGUAGES, ...ALLOWED_ANALYTICS_SOURCES]) {
      expect(performanceMigration).toContain(`'${value}'`);
    }
    expect(migrations).toContain("revoke all privileges");
    expect(migrations).toContain("grant insert on table public.usage_events to anon");
    expect(performanceMigration).not.toContain("properties ->> 'language' ~");
    expect(performanceMigration).not.toContain("properties ->> 'model' ~");
    expect(performanceMigration).not.toContain("properties ->> 'source' ~");
    for (const key of [
      "launch_context",
      "source",
      "output_action",
      "word_count_bucket",
      "duration_bucket",
      "language",
      "model",
      "compute_mode",
    ]) {
      expect(performanceMigration).toContain(`jsonb_typeof(properties -> '${key}') = 'string'`);
    }
  });
});
