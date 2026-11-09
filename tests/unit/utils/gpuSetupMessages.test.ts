import { describe, it, expect } from "vitest";
import { describeDownloadError, describeGpuCheckFailure } from "../../../src/utils/gpuSetupMessages";

describe("describeDownloadError", () => {
  it("names an offline PC instead of showing the errno", () => {
    expect(describeDownloadError("getaddrinfo ENOTFOUND updates.privatetranscribe.com")).toMatch(
      /online/
    );
  });

  it("says a cancel was the user's own", () => {
    expect(describeDownloadError("Download cancelled")).toBe("You cancelled the download.");
  });

  it("says a full disk, with the engine's size only for the engine", () => {
    expect(describeDownloadError("ENOSPC: no space left on device")).toContain("1 GB");
    expect(describeDownloadError("ENOSPC: no space left on device", "model")).not.toContain("1 GB");
  });

  it("keeps an unknown reason readable", () => {
    expect(describeDownloadError("HTTP 503")).toBe("The download failed: HTTP 503");
    expect(describeDownloadError("")).toMatch(/stopped/);
  });
});

describe("describeGpuCheckFailure", () => {
  it("names Windows' block", () => {
    const text = describeGpuCheckFailure(
      { success: true },
      { effectiveEngine: "cpu", fallback: { diagnostic: { kind: "blocked_by_os" } } }
    );
    expect(text).toMatch(/Smart App Control/);
  });

  it("points at the driver for a startup failure", () => {
    const text = describeGpuCheckFailure(
      { success: true },
      {
        effectiveEngine: "cpu",
        fallback: { diagnostic: { kind: "startup_failure", message: "exit code 3221225781" } },
      }
    );
    expect(text).toMatch(/driver/);
    expect(text).toContain("3221225781");
  });

  it("explains a server that started on the processor without a diagnostic", () => {
    expect(describeGpuCheckFailure({ success: true }, { effectiveEngine: "cpu" })).toMatch(
      /processor instead of the graphics card/
    );
  });

  it("reports a start that failed outright", () => {
    expect(
      describeGpuCheckFailure({ success: false, reason: "Model large not downloaded" }, null)
    ).toContain("not downloaded");
  });
});
