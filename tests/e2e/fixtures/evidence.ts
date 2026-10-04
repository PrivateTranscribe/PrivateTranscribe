import path from "node:path";

/**
 * A spec's screenshots and reports go to test-results/<name>/: gitignored, so a
 * run never dirties the repo, and outside Playwright's outputDir, which each run wipes.
 */
export function evidenceDir(name: string): string {
  return path.resolve(__dirname, "..", "..", "..", "test-results", name);
}
