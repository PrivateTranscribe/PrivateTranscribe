import { describe, expect, it } from "vitest";
import { cardStateForCudaProgress } from "../../../src/utils/cudaDownloadProgress";

describe("cardStateForCudaProgress", () => {
  it("shows the error and leaves Downloading when a download fails", () => {
    expect(cardStateForCudaProgress("failed", "HTTP 503")).toEqual({
      state: "error",
      error: "HTTP 503",
    });
    expect(cardStateForCudaProgress("failed", null).state).toBe("error");
    expect(cardStateForCudaProgress("failed", null).error).toBeTruthy();
  });

  it("goes back to idle on cancel, so the download button returns", () => {
    expect(cardStateForCudaProgress("cancelled")).toEqual({ state: "idle", error: null });
  });

  it("follows a running download and its end", () => {
    expect(cardStateForCudaProgress("downloading").state).toBe("downloading");
    expect(cardStateForCudaProgress("installing").state).toBe("downloading");
    expect(cardStateForCudaProgress(undefined).state).toBe("downloading");
    expect(cardStateForCudaProgress("done")).toEqual({ state: "done", error: null });
  });
});
