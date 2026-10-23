import { describe, expect, it } from "vitest";
import { resolveImportedHistoryLimit } from "../../../src/utils/historyLimitImport";

describe("resolveImportedHistoryLimit", () => {
  it("applies a limit that keeps every item this PC has", () => {
    expect(resolveImportedHistoryLimit(500, 50)).toEqual({ limit: 500 });
    expect(resolveImportedHistoryLimit(50, 50)).toEqual({ limit: 50 });
  });

  it("keeps a limit above 10,000, as the History limit field does", () => {
    // The old import clamped to 10,000, so a backup of a 20,000 limit
    // deleted half of the restored PC's history.
    expect(resolveImportedHistoryLimit(20_000, 20_000)).toEqual({ limit: 20_000 });
    expect(resolveImportedHistoryLimit(500_000, 50)).toEqual({ limit: 100_000 });
  });

  it("never lowers the limit, since that deletes history without asking", () => {
    const result = resolveImportedHistoryLimit(10, 5000);

    expect(result).not.toHaveProperty("limit");
    expect(result).toHaveProperty("skipReason", expect.stringContaining("delete history"));
  });

  it("brings history off (0) across to a PC that already has it off", () => {
    expect(resolveImportedHistoryLimit(0, 0)).toEqual({ limit: 0 });
  });

  it.each([-1, 1.5, "100", null])("refuses %j", (value) => {
    expect(resolveImportedHistoryLimit(value, 50)).toHaveProperty("skipReason");
  });
});
