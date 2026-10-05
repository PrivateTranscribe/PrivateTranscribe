import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const workflowPaths = [".github/workflows/release.yml"];

const readWorkflow = (relativePath: string) =>
  fs.readFileSync(path.join(process.cwd(), relativePath), "utf8");

/** The text of one job, from its key to the next top-level job key. */
const jobBlock = (workflow: string, job: string) => {
  const start = workflow.indexOf(`\n  ${job}:\n`);
  const rest = workflow.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[a-z][\w-]*:\n/);
  return next === -1 ? rest : rest.slice(0, next + 1);
};

describe("release workflow GitHub authentication", () => {
  it.each(workflowPaths)(
    "uses the automatic workflow token instead of an optional custom secret in %s",
    (relativePath) => {
      const workflow = readWorkflow(relativePath);

      expect(workflow).toContain("github.token");
      expect(workflow).not.toContain("secrets.GH_TOKEN");
    }
  );

  it("runs only when dispatched, from main, behind the production environment", () => {
    const workflow = readWorkflow(".github/workflows/release.yml");

    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).not.toMatch(/^\s+push:/m);
    expect(workflow).toContain("permissions: {}");
    expect(workflow).toContain('"$GITHUB_REF" != "refs/heads/main"');

    const check = jobBlock(workflow, "check");
    const release = jobBlock(workflow, "release");

    // The check job runs before approval, so it must never open a secret.
    expect(check).not.toContain("environment:");
    expect(check).not.toContain("secrets.");
    expect(check).toContain("refs/tags/v${VERSION}");
    expect(check).toContain("CHANGELOG.md");

    expect(release).toContain("needs: check");
    expect(release).toContain("environment: production");
  });

  it("uploads the update manifest only after the installer and the GitHub Release", () => {
    const workflow = readWorkflow(".github/workflows/release.yml");

    const installer = workflow.indexOf("name: Upload installer and blockmap to R2");
    const githubRelease = workflow.indexOf("name: Publish the GitHub Release");
    const manifest = workflow.indexOf("name: Upload latest.yml to R2");
    const liveCheck = workflow.indexOf("name: Verify the live update feed");

    expect(installer).toBeGreaterThan(-1);
    expect(githubRelease).toBeGreaterThan(installer);
    expect(manifest).toBeGreaterThan(githubRelease);
    expect(liveCheck).toBeGreaterThan(manifest);
  });
});
