import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const workflowPath = path.join(
  process.cwd(),
  ".github/workflows/publish-cuda-manifest.yml"
);

describe("CUDA manifest recovery workflow", () => {
  it("validates both engine packages before publishing and verifies the public manifest", () => {
    const workflow = fs.readFileSync(workflowPath, "utf8");

    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("engine_version:");
    expect(workflow).toContain("head-object");
    expect(workflow).toContain("whisper-server-win32-x64-cuda.zip");
    expect(workflow).toContain("whisper-server-linux-x64-cuda.zip");
    expect(workflow).toContain("binaries/latest-cuda.json");
    expect(workflow).toContain("--content-type application/json");
    expect(workflow).toContain("https://updates.privatetranscribe.com/binaries/latest-cuda.json");
    expect(workflow).toContain("published version mismatch");
  });
});
