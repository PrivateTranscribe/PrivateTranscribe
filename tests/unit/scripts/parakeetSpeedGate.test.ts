import { describe, it, expect } from "vitest";

const { median, judgeDecodes } = require("../../../scripts/benchmark-parakeet-speed");

const gate = { barMs: 1500, roundSize: 5 };

// Real decode times (ms) of the 10 s clip on windows-latest runners.
const RELEASE_RUN = [1230, 1907, 1334, 1524, 1672]; // 39026600828 attempt 1, AMD EPYC, 4 threads
const RELEASE_RERUN = [1336, 1139, 2688, 1194, 1199]; // same run, attempt 2
const QUIET_RUNS = [
  [1038, 1065, 1012, 1054, 1023], // 39024517840, AMD EPYC, 2 threads
  [1202, 1197, 1210, 1246, 1162], // 38168551502, AMD EPYC, 4 threads
  [1143, 1074, 1029, 1024, 1076], // 38029759615, Intel Xeon, 4 threads
  [976, 948, 934, 948, 923], // 37853692194, Intel Xeon, 2 threads
];

const slowedBy = (decodes: number[], factor: number) =>
  decodes.map((ms) => Math.round(ms * factor));

describe("median", () => {
  it("takes the middle value of an odd count", () => {
    expect(median([1907, 1230, 1524, 1334, 1672])).toBe(1524);
  });

  it("averages the two middle values of an even count", () => {
    expect(median([...RELEASE_RUN, ...RELEASE_RERUN])).toBe(1335);
  });
});

describe("judgeDecodes", () => {
  it("passes every quiet run on the first round", () => {
    for (const run of QUIET_RUNS) {
      expect(judgeDecodes(run, gate).verdict).toBe("pass");
    }
  });

  it("re-measures instead of failing when the first round is over the bar", () => {
    expect(judgeDecodes(RELEASE_RUN, gate)).toEqual({ verdict: "remeasure", median: 1524 });
  });

  it("passes the 17 Oct release run once the second round is pooled in", () => {
    expect(judgeDecodes([...RELEASE_RUN, ...RELEASE_RERUN], gate)).toEqual({
      verdict: "pass",
      median: 1335,
    });
  });

  it("fails a 25 % slowdown of the slowest quiet run in both rounds", () => {
    const slow = slowedBy(QUIET_RUNS[1], 1.25);
    expect(judgeDecodes(slow, gate).verdict).toBe("remeasure");
    expect(judgeDecodes([...slow, ...slow], gate).verdict).toBe("fail");
  });

  it("fails when a second slow round confirms the first", () => {
    expect(judgeDecodes([...RELEASE_RUN, ...RELEASE_RUN], gate).verdict).toBe("fail");
  });

  it("passes a run that sits exactly on the bar", () => {
    expect(judgeDecodes([1500, 1500, 1500, 1500, 1500], gate).verdict).toBe("pass");
  });
});
