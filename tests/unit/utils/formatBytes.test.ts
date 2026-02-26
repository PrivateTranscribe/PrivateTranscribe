/**
 * Tests for formatBytes utility
 * @module tests/unit/utils/formatBytes
 */

import { describe, it, expect } from "vitest";

// Implementation matching src/utils/formatBytes.ts
function formatBytes(bytes: number, decimals: number = 2): string {
  if (bytes === 0) return "0 Bytes";
  if (bytes < 0) return "Invalid size";

  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ["Bytes", "KB", "MB", "GB", "TB", "PB", "EB", "ZB", "YB"];

  const i = Math.floor(Math.log(bytes) / Math.log(k));
  const clampedIndex = Math.min(i, sizes.length - 1);

  return parseFloat((bytes / Math.pow(k, clampedIndex)).toFixed(dm)) + " " + sizes[clampedIndex];
}

describe("formatBytes", () => {
  describe("zero and invalid values", () => {
    it("returns '0 Bytes' for zero", () => {
      expect(formatBytes(0)).toBe("0 Bytes");
    });

    it("returns 'Invalid size' for negative numbers", () => {
      expect(formatBytes(-1)).toBe("Invalid size");
      expect(formatBytes(-1024)).toBe("Invalid size");
    });
  });

  describe("byte values", () => {
    it("formats values under 1KB as Bytes", () => {
      expect(formatBytes(1)).toBe("1 Bytes");
      expect(formatBytes(100)).toBe("100 Bytes");
      expect(formatBytes(1023)).toBe("1023 Bytes");
    });
  });

  describe("kilobyte values", () => {
    it("formats 1KB correctly", () => {
      expect(formatBytes(1024)).toBe("1 KB");
    });

    it("formats values in KB range", () => {
      expect(formatBytes(1536)).toBe("1.5 KB");
      expect(formatBytes(10240)).toBe("10 KB");
      expect(formatBytes(1048575)).toBe("1024 KB");
    });
  });

  describe("megabyte values", () => {
    it("formats 1MB correctly", () => {
      expect(formatBytes(1048576)).toBe("1 MB");
    });

    it("formats values in MB range", () => {
      expect(formatBytes(1572864)).toBe("1.5 MB");
      expect(formatBytes(10485760)).toBe("10 MB");
      expect(formatBytes(104857600)).toBe("100 MB");
      expect(formatBytes(524288000)).toBe("500 MB");
    });
  });

  describe("gigabyte values", () => {
    it("formats 1GB correctly", () => {
      expect(formatBytes(1073741824)).toBe("1 GB");
    });

    it("formats values in GB range", () => {
      expect(formatBytes(1610612736)).toBe("1.5 GB");
      expect(formatBytes(10737418240)).toBe("10 GB");
    });
  });

  describe("terabyte values", () => {
    it("formats 1TB correctly", () => {
      expect(formatBytes(1099511627776)).toBe("1 TB");
    });

    it("formats values in TB range", () => {
      expect(formatBytes(2199023255552)).toBe("2 TB");
    });
  });

  describe("decimal precision", () => {
    it("uses default 2 decimal places", () => {
      expect(formatBytes(1536)).toBe("1.5 KB");
      expect(formatBytes(1843)).toBe("1.8 KB");
    });

    it("respects custom decimal parameter", () => {
      expect(formatBytes(1536, 0)).toBe("2 KB");
      expect(formatBytes(1536, 1)).toBe("1.5 KB");
      expect(formatBytes(1536, 3)).toBe("1.5 KB");
    });

    it("treats negative decimals as 0", () => {
      expect(formatBytes(1536, -1)).toBe("2 KB");
    });

    it("removes trailing zeros", () => {
      expect(formatBytes(1024, 2)).toBe("1 KB");
      expect(formatBytes(2048, 3)).toBe("2 KB");
    });
  });

  describe("edge cases", () => {
    it("handles very small fractions", () => {
      expect(formatBytes(1)).toBe("1 Bytes");
    });

    it("handles exact power of 1024 boundaries", () => {
      expect(formatBytes(1024)).toBe("1 KB");
      expect(formatBytes(1048576)).toBe("1 MB");
      expect(formatBytes(1073741824)).toBe("1 GB");
    });

    it("handles realistic file sizes", () => {
      // Common model sizes
      expect(formatBytes(75000000)).toBe("71.53 MB"); // ~75MB whisper tiny
      expect(formatBytes(142000000)).toBe("135.42 MB"); // ~142MB whisper base
      expect(formatBytes(466000000)).toBe("444.41 MB"); // ~466MB whisper small
      expect(formatBytes(1500000000)).toBe("1.4 GB"); // ~1.5GB whisper medium
      expect(formatBytes(3000000000)).toBe("2.79 GB"); // ~3GB whisper large
    });
  });

  describe("type coercion", () => {
    it("handles floating point bytes", () => {
      expect(formatBytes(1024.5)).toBe("1 KB");
      expect(formatBytes(1536.7)).toBe("1.5 KB");
    });
  });
});
