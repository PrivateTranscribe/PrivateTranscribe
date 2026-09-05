/**
 * The ten pinned Agent Mode rambles, rewritten once through the real Claude
 * Code CLI (Haiku, the spawn settings in agentPromptRewriter.js) and recorded
 * in tests/fixtures/agent-rambles/rewrites.json. No test here calls the CLI:
 * the fixture is the evidence, and these cases pin what a rewrite must keep
 * so a prompt change that drops a path or invents a fact is caught when the
 * fixture is re-recorded.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { extractSendCommand } from "../../../src/utils/agentPrompt";

interface RecordedRewrite {
  n: number;
  spoken: string;
  send: boolean;
  rewritten: string;
  ms: number;
  apiMs: number;
}

const fixture = JSON.parse(
  fs.readFileSync(
    path.join(process.cwd(), "tests", "fixtures", "agent-rambles", "rewrites.json"),
    "utf8"
  )
) as { rambles: RecordedRewrite[] };

/** The technical details each ramble carries; every one must survive, as code. */
const MUST_KEEP: Record<number, string[]> = {
  1: ["`auth/login.ts`", "`validate`", "test"],
  2: ["`useEffect`", "`user_id`", "page.tsx`"],
  3: ["`debug.log`"],
  4: ["`package.json`", "`build`", "Windows"],
  5: ["`tests/e2e/login.spec.ts`", "wait"],
  6: ["`feature/auth-2`", "`login.ts`", "main"],
  7: ["`user_id`", "`orders`", "`created_at`", "down migration"],
  8: ["`send_enter`", "`auto_send`", "`settings.ts`", "`main.js`", "one release"],
  9: ["`app.css`", "narrow windows", "mobile breakpoint"],
  10: ["`crate::parser`", "`parse_line`", "empty input", "guard"],
};

describe("recorded Claude Code rewrites of the ten rambles", () => {
  it("covers all ten rambles", () => {
    expect(fixture.rambles.map((r) => r.n)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it.each(fixture.rambles)("ramble $n keeps its technical details as code", (row) => {
    for (const detail of MUST_KEEP[row.n]) {
      expect(row.rewritten).toContain(detail);
    }
    expect(row.rewritten).toMatch(/`[^`]+`/);
  });

  it.each(fixture.rambles)("ramble $n drops filler and spoken separators", (row) => {
    expect(row.rewritten).not.toMatch(/\b(um|uh)\b/i);
    expect(row.rewritten).not.toMatch(/\b(slash|underscore|colon colon)\b/i);
    expect(row.rewritten).not.toMatch(/\bdot (ts|tsx|js|json|css|txt|log)\b/i);
  });

  it("resolves a change of mind to the final intent (ramble 3)", () => {
    const row = fixture.rambles[2];
    expect(row.rewritten).not.toContain("log.txt");
    expect(row.rewritten).not.toMatch(/no wait/i);
  });

  it("leaves the send word to the app, not the model", () => {
    for (const row of fixture.rambles) {
      expect(row.send).toBe(extractSendCommand(row.spoken).send);
      expect(row.rewritten).not.toMatch(/\bsend( it| now)?\.?$/i);
    }
    expect(fixture.rambles.filter((r) => r.send).map((r) => r.n)).toEqual([1, 2, 4, 5, 8, 10]);
  });

  it("was recorded under the four second bar", () => {
    const sorted = fixture.rambles.map((r) => r.ms).sort((a, b) => a - b);
    const p95 = sorted[Math.ceil(0.95 * sorted.length) - 1];
    expect(p95).toBeLessThan(4000);
  });
});
