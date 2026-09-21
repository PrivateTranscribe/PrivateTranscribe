import { describe, expect, it } from "vitest";

const {
  centroid,
  clusterDurations,
  reassignSmallClusters,
  representativeSegments,
  selectSmallClusters,
} = require("../../../src/helpers/diarizationClusters");

const segments = [
  { speaker: 0, start: 0, end: 30 },
  { speaker: 1, start: 31, end: 50 },
  { speaker: 0, start: 51, end: 70 },
  { speaker: 2, start: 71, end: 71.4 },
  { speaker: 3, start: 72, end: 75 },
];

describe("diarization small clusters", () => {
  it("sums seconds per cluster", () => {
    const durations = clusterDurations(segments);
    expect(durations.get("0")).toBeCloseTo(49);
    expect(durations.get("2")).toBeCloseTo(0.4);
  });

  it("uses the larger of an absolute and a relative floor", () => {
    const durations = clusterDurations(segments);
    const bySeconds = selectSmallClusters(durations, { minClusterSeconds: 5 });
    expect([...bySeconds.small].sort()).toEqual(["2", "3"]);
    const byShare = selectSmallClusters(durations, { minClusterShare: 0.3 });
    // 30% of 71.4 s is 21.4 s: only the 49 s cluster survives.
    expect([...byShare.large]).toEqual(["0"]);
    expect([...byShare.small].sort()).toEqual(["1", "2", "3"]);
  });

  it("never dissolves everything and is off by default", () => {
    const durations = clusterDurations(segments);
    const off = selectSmallClusters(durations, {});
    expect(off.small.size).toBe(0);
    expect(off.large.size).toBe(4);
    const extreme = selectSmallClusters(durations, { minClusterSeconds: 1000 });
    expect([...extreme.large]).toEqual(["0"]);
    expect(extreme.small.size).toBe(3);
  });

  it("ranks representative segments by length and bounds them", () => {
    const picked = representativeSegments(segments, "0", 1);
    expect(picked).toEqual([{ speaker: 0, start: 0, end: 30 }]);
  });

  it("attaches each small cluster to the most similar large cluster", () => {
    const centroids = new Map([
      ["0", centroid([{ vector: [1, 0, 0], weight: 30 }])],
      ["1", centroid([{ vector: [0, 1, 0], weight: 19 }])],
      ["2", centroid([{ vector: [0.9, 0.1, 0], weight: 0.4 }])],
      ["3", centroid([{ vector: [0.2, 0.9, 0], weight: 3 }])],
    ]);
    const { segments: merged, merges } = reassignSmallClusters(
      segments,
      new Set(["2", "3"]),
      new Set(["0", "1"]),
      centroids
    );
    expect(merges).toEqual([
      { from: "2", to: "0", similarity: expect.any(Number) },
      { from: "3", to: "1", similarity: expect.any(Number) },
    ]);
    expect(merged.map((s) => String(s.speaker))).toEqual(["0", "1", "0", "0", "1"]);
    expect(new Set(merged.map((s) => String(s.speaker))).size).toBe(2);
  });

  it("keeps a small cluster that has no usable centroid", () => {
    const centroids = new Map([["0", centroid([{ vector: [1, 0], weight: 1 }])]]);
    const { segments: merged, merges } = reassignSmallClusters(
      segments,
      new Set(["2"]),
      new Set(["0"]),
      centroids
    );
    expect(merges).toEqual([]);
    expect(merged[3].speaker).toBe(2);
  });

  it("weights centroids by duration", () => {
    const vector = centroid([
      { vector: [1, 0], weight: 10 },
      { vector: [0, 1], weight: 0.1 },
    ]);
    expect(vector[0]).toBeGreaterThan(0.99);
  });
});
