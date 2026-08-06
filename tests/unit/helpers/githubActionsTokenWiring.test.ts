import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const workflowPaths = [
  ".github/workflows/build-and-notarize.yml",
  ".github/workflows/release-production.yml",
];

describe("release workflow GitHub authentication", () => {
  it.each(workflowPaths)(
    "uses the automatic workflow token instead of an optional custom secret in %s",
    (relativePath) => {
      const workflow = fs.readFileSync(path.join(process.cwd(), relativePath), "utf8");

      expect(workflow).toContain("github.token");
      expect(workflow).not.toContain("secrets.GH_TOKEN");
    }
  );

  it("supports explicit production dispatch without weakening the push version gate", () => {
    const workflow = fs.readFileSync(
      path.join(process.cwd(), ".github/workflows/release-production.yml"),
      "utf8"
    );

    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("if: github.event_name == 'push'");
    expect(workflow).toContain("if: github.event_name == 'workflow_dispatch'");
  });
});
