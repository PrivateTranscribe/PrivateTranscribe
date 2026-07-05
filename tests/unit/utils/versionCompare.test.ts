import { describe, expect, it } from "vitest";
import { isNewerVersion, parseVersionParts } from "../../../src/utils/versionCompare";

describe("parseVersionParts", () => {
  it("parses plain and v-prefixed versions", () => {
    expect(parseVersionParts("0.0.9")).toEqual([0, 0, 9]);
    expect(parseVersionParts("v0.0.9")).toEqual([0, 0, 9]);
    expect(parseVersionParts("V1.13.0")).toEqual([1, 13, 0]);
  });

  it("rejects malformed input", () => {
    expect(parseVersionParts("")).toBeNull();
    expect(parseVersionParts("latest")).toBeNull();
    expect(parseVersionParts("1.2.x")).toBeNull();
    expect(parseVersionParts("1..2")).toBeNull();
    expect(parseVersionParts("v")).toBeNull();
  });
});

describe("isNewerVersion", () => {
  it("detects a newer engine version", () => {
    expect(isNewerVersion("v0.0.9", "v0.0.8")).toBe(true);
    expect(isNewerVersion("v0.1.0", "v0.0.9")).toBe(true);
    expect(isNewerVersion("v1.0.0", "v0.9.9")).toBe(true);
  });

  it("is false for equal or older versions", () => {
    expect(isNewerVersion("v0.0.8", "v0.0.8")).toBe(false);
    expect(isNewerVersion("v0.0.8", "v0.0.9")).toBe(false);
  });

  it("compares numerically, not lexically", () => {
    expect(isNewerVersion("v0.0.10", "v0.0.9")).toBe(true);
    expect(isNewerVersion("v0.0.9", "v0.0.10")).toBe(false);
  });

  it("treats different lengths as zero-padded", () => {
    expect(isNewerVersion("v1.0", "v1.0.0")).toBe(false);
    expect(isNewerVersion("v1.0.1", "v1.0")).toBe(true);
  });

  it("is false when either side is unknown or malformed", () => {
    expect(isNewerVersion(null, "v0.0.8")).toBe(false);
    expect(isNewerVersion("v0.0.9", undefined)).toBe(false);
    expect(isNewerVersion("latest", "v0.0.8")).toBe(false);
    expect(isNewerVersion("v0.0.9", "latest")).toBe(false);
  });
});
