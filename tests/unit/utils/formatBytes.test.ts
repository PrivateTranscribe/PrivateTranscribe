import { describe, expect, it } from "vitest";
import { formatBytes } from "../../../src/utils/formatBytes";

describe("formatBytes", () => {
  it.each([
    [0, undefined, "0 Bytes"],
    [1, undefined, "1 Bytes"],
    [1023, undefined, "1023 Bytes"],
    [1024, undefined, "1 KB"],
    [1536, undefined, "1.5 KB"],
    [1048576, undefined, "1 MB"],
    [1073741824, undefined, "1 GB"],
    [1099511627776, undefined, "1 TB"],
    [75000000, undefined, "71.53 MB"],
    [1536, 0, "2 KB"],
    [1536, 1, "1.5 KB"],
    [1536, -1, "2 KB"],
    [1024.5, undefined, "1 KB"],
  ])("formats %s bytes", (bytes, decimals, expected) => {
    expect(formatBytes(bytes, decimals)).toBe(expected);
  });
});
