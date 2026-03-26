import { describe, it, expect } from "vitest";

// Import pure helpers from the benchmark script (CJS module).
const {
  timeSync,
  timeAsync,
  buildScenarios,
  assembleFinalPrompt,
  formatTable,
  formatSummary,
  computeIncrementalOverhead,
  FIXTURE_WINDOW_TITLE,
  FIXTURE_APP_NAME,
  FIXTURE_SOURCE_CONTENT,
  FIXTURE_BASE_TEXT,
} = require("../../../scripts/benchmark-context");

// ── timeSync ───────────────────────────────────────────────────────────────────

describe("timeSync", () => {
  it("returns the function result", () => {
    const { result } = timeSync(() => 42);
    expect(result).toBe(42);
  });

  it("returns a non-negative elapsedMs", () => {
    const { elapsedMs } = timeSync(() => {});
    expect(elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it("measures non-zero time for a busy function", () => {
    // Busy-loop to guarantee some measurable time
    const { elapsedMs } = timeSync(() => {
      let x = 0;
      for (let i = 0; i < 1_000_000; i++) x += i;
      return x;
    });
    expect(elapsedMs).toBeGreaterThan(0);
  });

  it("propagates the return value for object results", () => {
    const { result } = timeSync(() => ({ ok: true, count: 3 }));
    expect(result).toEqual({ ok: true, count: 3 });
  });

  it("works when fn returns null", () => {
    const { result } = timeSync(() => null);
    expect(result).toBeNull();
  });
});

// ── timeAsync ──────────────────────────────────────────────────────────────────

describe("timeAsync", () => {
  it("returns the resolved value", async () => {
    const { result } = await timeAsync(async () => "hello");
    expect(result).toBe("hello");
  });

  it("returns a non-negative elapsedMs", async () => {
    const { elapsedMs } = await timeAsync(async () => {});
    expect(elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it("works with a promise that resolves after a tick", async () => {
    const { result } = await timeAsync(() => Promise.resolve(99));
    expect(result).toBe(99);
  });
});

// ── buildScenarios ─────────────────────────────────────────────────────────────

describe("buildScenarios", () => {
  it("returns exactly 3 scenarios", () => {
    expect(buildScenarios()).toHaveLength(3);
  });

  it("first scenario is baseline with null context", () => {
    const [baseline] = buildScenarios();
    expect(baseline.id).toBe("baseline");
    expect(baseline.context).toBeNull();
    expect(baseline.sourceContent).toBeNull();
  });

  it("second scenario has window context but no source content", () => {
    const [, windowCtx] = buildScenarios();
    expect(windowCtx.id).toBe("window-context");
    expect(windowCtx.context).not.toBeNull();
    expect(windowCtx.context.available).toBe(true);
    expect(windowCtx.sourceContent).toBeNull();
  });

  it("third scenario has both window context and source content", () => {
    const [, , withFileIds] = buildScenarios();
    expect(withFileIds.id).toBe("window-file-ids");
    expect(withFileIds.context).not.toBeNull();
    expect(withFileIds.sourceContent).toBeTruthy();
  });

  it("all scenarios are marked simulated: true", () => {
    expect(buildScenarios().every((s) => s.simulated === true)).toBe(true);
  });

  it("window context scenarios use the fixture window title and app name", () => {
    const [, windowCtx, withFileIds] = buildScenarios();
    expect(windowCtx.context.windowTitle).toBe(FIXTURE_WINDOW_TITLE);
    expect(windowCtx.context.appName).toBe(FIXTURE_APP_NAME);
    expect(withFileIds.context.windowTitle).toBe(FIXTURE_WINDOW_TITLE);
  });

  it("source content in window+file-ids matches fixture", () => {
    const [, , withFileIds] = buildScenarios();
    expect(withFileIds.sourceContent).toBe(FIXTURE_SOURCE_CONTENT);
  });
});

// ── assembleFinalPrompt ────────────────────────────────────────────────────────

describe("assembleFinalPrompt", () => {
  it("returns base text unchanged when hints array is empty", () => {
    expect(assembleFinalPrompt("hello", [])).toBe("hello");
  });

  it("returns base text unchanged when hints is undefined", () => {
    expect(assembleFinalPrompt("hello", undefined as unknown as string[])).toBe("hello");
  });

  it("joins base text and a single hint with newline", () => {
    expect(assembleFinalPrompt("base", ["hint"])).toBe("base\nhint");
  });

  it("joins base text and multiple hints with newlines", () => {
    const result = assembleFinalPrompt("base", ["hint1", "hint2"]);
    expect(result).toBe("base\nhint1\nhint2");
  });

  it("filters out empty string hints", () => {
    expect(assembleFinalPrompt("base", ["", "real-hint", ""])).toBe("base\nreal-hint");
  });

  it("filters out whitespace-only hints", () => {
    expect(assembleFinalPrompt("base", ["   ", "valid"])).toBe("base\nvalid");
  });

  it("returns base text alone when all hints are empty", () => {
    expect(assembleFinalPrompt("base", ["", "  "])).toBe("base");
  });

  it("works with null hints inside array", () => {
    // null is not a string so typeof null !== 'string' — filtered out
    expect(assembleFinalPrompt("base", [null as unknown as string, "ok"])).toBe("base\nok");
  });
});

// ── formatTable ────────────────────────────────────────────────────────────────

describe("formatTable", () => {
  const sampleRows = [
    { scenario: "Baseline (no context)", stage: "context-prep", elapsedMs: 0.0023 },
    { scenario: "Baseline (no context)", stage: "prompt-assemble", elapsedMs: 0.0011 },
    { scenario: "Window title + app name", stage: "whisper-hint", elapsedMs: 0.0045 },
  ];

  it("returns a non-empty string", () => {
    expect(formatTable(sampleRows).length).toBeGreaterThan(0);
  });

  it("contains all scenario names", () => {
    const table = formatTable(sampleRows);
    expect(table).toContain("Baseline (no context)");
    expect(table).toContain("Window title + app name");
  });

  it("contains all stage names", () => {
    const table = formatTable(sampleRows);
    expect(table).toContain("context-prep");
    expect(table).toContain("prompt-assemble");
    expect(table).toContain("whisper-hint");
  });

  it("contains the elapsed time values formatted to 4 decimal places", () => {
    const table = formatTable(sampleRows);
    expect(table).toContain("0.0023");
    expect(table).toContain("0.0045");
  });

  it("contains header labels", () => {
    const table = formatTable(sampleRows);
    expect(table).toContain("Scenario");
    expect(table).toContain("Stage");
    expect(table).toContain("Avg ms");
  });

  it("handles an empty rows array", () => {
    const table = formatTable([]);
    expect(typeof table).toBe("string");
    expect(table).toContain("Scenario");
  });
});

// ── formatSummary ──────────────────────────────────────────────────────────────

describe("formatSummary", () => {
  const sampleTotals = {
    "Baseline (no context)": 0.002,
    "Window title + app name": 0.015,
    "Window + file identifiers": 0.08,
  };

  it("returns a non-empty string", () => {
    expect(formatSummary(sampleTotals).length).toBeGreaterThan(0);
  });

  it("contains all scenario labels", () => {
    const summary = formatSummary(sampleTotals);
    expect(summary).toContain("Baseline (no context)");
    expect(summary).toContain("Window title + app name");
    expect(summary).toContain("Window + file identifiers");
  });

  it("contains formatted time values", () => {
    const summary = formatSummary(sampleTotals);
    expect(summary).toContain("0.0020");
    expect(summary).toContain("0.0150");
  });

  it("contains the header label", () => {
    const summary = formatSummary(sampleTotals);
    expect(summary).toContain("Total overhead (ms)");
  });

  it("handles empty totals object", () => {
    const summary = formatSummary({});
    expect(typeof summary).toBe("string");
    expect(summary).toContain("Scenario");
  });
});

// ── computeIncrementalOverhead ─────────────────────────────────────────────────

describe("computeIncrementalOverhead", () => {
  const totals = {
    "Baseline (no context)": 0.003,
    "Window title + app name": 0.012,
    "Window + file identifiers": 0.045,
  };

  it("excludes the baseline scenario from results", () => {
    const result = computeIncrementalOverhead(totals, "Baseline (no context)");
    expect(result.every((r) => r.label !== "Baseline (no context)")).toBe(true);
  });

  it("returns one entry per non-baseline scenario", () => {
    const result = computeIncrementalOverhead(totals, "Baseline (no context)");
    expect(result).toHaveLength(2);
  });

  it("computes correct delta for window-context scenario", () => {
    const result = computeIncrementalOverhead(totals, "Baseline (no context)");
    const windowCtx = result.find((r) => r.label === "Window title + app name");
    expect(windowCtx).toBeDefined();
    expect(windowCtx!.deltaMs).toBeCloseTo(0.012 - 0.003, 6);
  });

  it("computes correct delta for window+file-ids scenario", () => {
    const result = computeIncrementalOverhead(totals, "Baseline (no context)");
    const withIds = result.find((r) => r.label === "Window + file identifiers");
    expect(withIds).toBeDefined();
    expect(withIds!.deltaMs).toBeCloseTo(0.045 - 0.003, 6);
  });

  it("returns empty array when only baseline is present", () => {
    const result = computeIncrementalOverhead(
      { "Baseline (no context)": 0.001 },
      "Baseline (no context)",
    );
    expect(result).toHaveLength(0);
  });

  it("uses zero as baseline when label is missing from totals", () => {
    const result = computeIncrementalOverhead({ "ScenarioA": 0.05 }, "NonExistent");
    expect(result).toHaveLength(1);
    expect(result[0].deltaMs).toBeCloseTo(0.05, 6);
  });
});

// ── Fixture constants ──────────────────────────────────────────────────────────

describe("fixture constants", () => {
  it("FIXTURE_WINDOW_TITLE contains a filename-like token for parseFilenameFromTitle", () => {
    // The title uses an em-dash separator, so parseFilenameFromTitle should extract a filename
    expect(FIXTURE_WINDOW_TITLE).toMatch(/\.js/);
    expect(FIXTURE_WINDOW_TITLE.length).toBeGreaterThan(10);
  });

  it("FIXTURE_APP_NAME is a non-empty string", () => {
    expect(typeof FIXTURE_APP_NAME).toBe("string");
    expect(FIXTURE_APP_NAME.length).toBeGreaterThan(0);
  });

  it("FIXTURE_SOURCE_CONTENT contains valid JavaScript identifiers", () => {
    // Should contain camelCase and function keywords that extractIdentifiers will find
    expect(FIXTURE_SOURCE_CONTENT).toContain("function");
    expect(FIXTURE_SOURCE_CONTENT).toContain("const");
  });

  it("FIXTURE_BASE_TEXT is a non-empty string", () => {
    expect(typeof FIXTURE_BASE_TEXT).toBe("string");
    expect(FIXTURE_BASE_TEXT.length).toBeGreaterThan(0);
  });
});
