import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(__dirname, "../../..");
const workflow = readFileSync(resolve(repoRoot, ".github/workflows/build-windows.yml"), "utf8");

/** Comment lines explain what the workflow deliberately does not do, so asserting
 *  an absence has to look at what actually runs. */
const steps = workflow
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("#"))
  .join("\n");

/**
 * build-windows.yml makes a signed installer to try before a release. It used to
 * publish to the update feed too, on a manual switch or on any pushed v* tag, and
 * 0.14.1 and 0.14.2 reached users that way without the version-bump check in
 * release-production.yml. None of this runs in a normal test, so these
 * assertions stand in for it.
 */
describe("Windows test installer workflow", () => {
  test("never publishes to the update feed", () => {
    expect(steps).not.toMatch(/s3 cp|latest\.yml|R2_/);
  });

  test("runs only when started by hand", () => {
    expect(steps).toContain("workflow_dispatch");
    expect(steps).not.toMatch(/^\s*(push|tags):/m);
  });

  test("bundles what a release bundles", () => {
    // A hand-picked download list drifted from the release: it pinned an old
    // llama.cpp and stopped passing once afterPack probed llama-server.
    expect(steps).toContain("npm run prepare:resources");
    expect(steps).not.toContain("LLAMA_CPP_VERSION");
  });
});
