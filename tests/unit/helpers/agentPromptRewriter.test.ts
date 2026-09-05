import { spawn as realSpawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  AgentPromptRewriter,
  buildRewriteArgs,
  buildRewriteEnv,
  AGENT_REWRITE_SYSTEM_PROMPT,
  AGENT_REWRITE_MODEL,
  AGENT_REWRITE_DIAG_FLAG,
} = require("../../../src/helpers/agentPromptRewriter");

/**
 * Every case here drives a node stub, never the real `claude` binary: a live
 * run would spend the user's subscription and take seconds per case.
 *
 * The stub is pointed at the same way tests/e2e points ConverseAgent at one —
 * `claudeBin: process.execPath` plus the script on PT_CONVERSE_CLAUDE_ARGS —
 * because Node refuses to spawn a `.cmd` shim on Windows without a shell.
 */
const STUB_SOURCE = [
  'const fs = require("node:fs");',
  "const chunks = [];",
  'process.stdin.on("data", (chunk) => chunks.push(chunk));',
  'process.stdin.on("end", () => {',
  "  const record = {",
  "    argv: process.argv.slice(2),",
  "    env: {",
  "      ENABLE_CLAUDEAI_MCP_SERVERS: process.env.ENABLE_CLAUDEAI_MCP_SERVERS || null,",
  "      CLAUDE_CODE_DISABLE_AUTO_MEMORY: process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY || null,",
  "      MAX_THINKING_TOKENS: process.env.MAX_THINKING_TOKENS || null,",
  "    },",
  '    stdin: chunks.join(""),',
  "  };",
  "  if (process.env.STUB_LOG) {",
  "    fs.appendFileSync(",
  "      process.env.STUB_LOG,",
  "      JSON.stringify(record) + String.fromCharCode(10)",
  "    );",
  "  }",
  "  const emit = () => {",
  "    if (process.env.STUB_STDERR) process.stderr.write(process.env.STUB_STDERR);",
  "    if (process.env.STUB_REPLY) process.stdout.write(process.env.STUB_REPLY);",
  "    process.exit(Number(process.env.STUB_EXIT || 0));",
  "  };",
  "  const sleepMs = Number(process.env.STUB_SLEEP_MS || 0);",
  "  if (sleepMs > 0) setTimeout(emit, sleepMs);",
  "  else emit();",
  "});",
].join("\n");

const RAMBLE = "so the login page blows up when you hit auth slash login dot ts";

const GOOD_REPLY = JSON.stringify({
  result: "Fix `x`.",
  is_error: false,
  duration_api_ms: 1180,
  usage: { input_tokens: 507, output_tokens: 31 },
});

describe("agent prompt rewriter", () => {
  let dir: string;
  let stubPath: string;
  let logPath: string;
  let originalArgs: string | undefined;
  let originalFlag: string | undefined;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-agent-rewrite-"));
    stubPath = path.join(dir, "claude-stub.cjs");
    logPath = path.join(dir, "stub-log.jsonl");
    fs.writeFileSync(stubPath, STUB_SOURCE);
    originalArgs = process.env.PT_CONVERSE_CLAUDE_ARGS;
    originalFlag = process.env[AGENT_REWRITE_DIAG_FLAG];
    process.env.PT_CONVERSE_CLAUDE_ARGS = JSON.stringify([stubPath]);
    delete process.env[AGENT_REWRITE_DIAG_FLAG];
  });

  afterEach(() => {
    if (originalArgs === undefined) delete process.env.PT_CONVERSE_CLAUDE_ARGS;
    else process.env.PT_CONVERSE_CLAUDE_ARGS = originalArgs;
    if (originalFlag === undefined) delete process.env[AGENT_REWRITE_DIAG_FLAG];
    else process.env[AGENT_REWRITE_DIAG_FLAG] = originalFlag;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const stubEnv = (extra: Record<string, string> = {}) => ({
    ...process.env,
    STUB_LOG: logPath,
    ...extra,
  });

  const makeRewriter = (
    extraEnv: Record<string, string> = {},
    opts: Record<string, unknown> = {}
  ) =>
    new AgentPromptRewriter({
      claudeBin: process.execPath,
      env: stubEnv(extraEnv),
      ...opts,
    });

  const readLog = () =>
    fs
      .readFileSync(logPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));

  describe("buildRewriteArgs / buildRewriteEnv", () => {
    it("returns exactly the slim print-mode flag list", () => {
      expect(buildRewriteArgs(AGENT_REWRITE_SYSTEM_PROMPT, AGENT_REWRITE_MODEL)).toEqual([
        "--print",
        "--model",
        "haiku",
        "--strict-mcp-config",
        "--mcp-config",
        '{"mcpServers":{}}',
        "--tools",
        "",
        "--setting-sources",
        "",
        "--no-session-persistence",
        "--output-format",
        "json",
        "--system-prompt",
        AGENT_REWRITE_SYSTEM_PROMPT,
      ]);
    });

    it("adds the three overrides without dropping the base environment", () => {
      const built = buildRewriteEnv({ PATH: "/keep/me", MAX_THINKING_TOKENS: "9999" });
      expect(built.PATH).toBe("/keep/me");
      expect(built.ENABLE_CLAUDEAI_MCP_SERVERS).toBe("false");
      expect(built.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe("1");
      expect(built.MAX_THINKING_TOKENS).toBe("0");
    });
  });

  describe("rewrite()", () => {
    it("carries the CLI's answer, timings and token counts back", async () => {
      const result = await makeRewriter({ STUB_REPLY: GOOD_REPLY }).rewrite(RAMBLE);

      expect(result.ok).toBe(true);
      expect(result.text).toBe("Fix `x`.");
      expect(result.apiMs).toBe(1180);
      expect(result.inputTokens).toBe(507);
      expect(result.outputTokens).toBe(31);
      expect(typeof result.ms).toBe("number");

      const [call] = readLog();
      expect(call.stdin).toBe(RAMBLE);
      expect(call.argv).toEqual(buildRewriteArgs(AGENT_REWRITE_SYSTEM_PROMPT, "haiku"));
      expect(call.env).toEqual({
        ENABLE_CLAUDEAI_MCP_SERVERS: "false",
        CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
        MAX_THINKING_TOKENS: "0",
      });
    });

    it("unwraps a fenced answer once", async () => {
      const reply = JSON.stringify({ result: "```\nFix `x`.\n```", is_error: false });
      const result = await makeRewriter({ STUB_REPLY: reply }).rewrite(RAMBLE);
      expect(result.ok).toBe(true);
      expect(result.text).toBe("Fix `x`.");
    });

    it("unwraps a quoted answer once", async () => {
      const reply = JSON.stringify({ result: '"Fix the login page."', is_error: false });
      const result = await makeRewriter({ STUB_REPLY: reply }).rewrite(RAMBLE);
      expect(result.ok).toBe(true);
      expect(result.text).toBe("Fix the login page.");
    });

    it("leaves a prompt that opens and closes on code spans alone", async () => {
      const text = "`npm run build` fails on Windows, check `package.json`";
      const reply = JSON.stringify({ result: text, is_error: false });
      const result = await makeRewriter({ STUB_REPLY: reply }).rewrite(RAMBLE);
      expect(result.ok).toBe(true);
      expect(result.text).toBe(text);
    });

    it("reports is_error as an exit, with the CLI's own message", async () => {
      const reply = JSON.stringify({ result: "Credit balance is too low", is_error: true });
      const result = await makeRewriter({ STUB_REPLY: reply }).rewrite(RAMBLE);
      expect(result.ok).toBe(false);
      expect(result.reason).toBe("exit");
      expect(result.message).toBe("Credit balance is too low");
    });

    it("reports a non-zero exit code", async () => {
      const result = await makeRewriter({ STUB_EXIT: "3" }).rewrite(RAMBLE);
      expect(result.ok).toBe(false);
      expect(result.reason).toBe("exit");
      expect(result.message).toBe("exit code 3");
    });

    it("prefers stderr over the bare exit code in the message", async () => {
      const result = await makeRewriter({
        STUB_EXIT: "1",
        STUB_STDERR: "Not logged in",
      }).rewrite(RAMBLE);
      expect(result.reason).toBe("exit");
      expect(result.message).toBe("Not logged in");
    });

    it("reports stdout that is not JSON as bad output", async () => {
      const result = await makeRewriter({ STUB_REPLY: "not json at all" }).rewrite(RAMBLE);
      expect(result.ok).toBe(false);
      expect(result.reason).toBe("bad-output");
    });

    it("reports a blank result as empty", async () => {
      const reply = JSON.stringify({ result: "   ", is_error: false });
      const result = await makeRewriter({ STUB_REPLY: reply }).rewrite(RAMBLE);
      expect(result.ok).toBe(false);
      expect(result.reason).toBe("empty");
    });

    it("kills a child that runs past the timeout", async () => {
      const children: Array<{ killed: boolean }> = [];
      const rewriter = makeRewriter(
        { STUB_SLEEP_MS: "4000", STUB_REPLY: GOOD_REPLY },
        {
          timeoutMs: 300,
          spawn: (...args: unknown[]) => {
            // @ts-expect-error forwarding the real spawn signature verbatim
            const child = realSpawn(...args);
            children.push(child as unknown as { killed: boolean });
            return child;
          },
        }
      );

      const result = await rewriter.rewrite(RAMBLE);
      expect(result.ok).toBe(false);
      expect(result.reason).toBe("timeout");
      expect(children).toHaveLength(1);
      expect(children[0].killed).toBe(true);
    });

    it("refuses blank input without spawning", async () => {
      const rewriter = makeRewriter({ STUB_REPLY: GOOD_REPLY });
      expect((await rewriter.rewrite("   ")).reason).toBe("empty-input");
      expect((await rewriter.rewrite("")).reason).toBe("empty-input");
      expect((await rewriter.rewrite(null)).reason).toBe("empty-input");
      expect(fs.existsSync(logPath)).toBe(false);
    });
  });

  describe("the diagnostic flag", () => {
    it("turns the rewriter off without spawning", async () => {
      process.env[AGENT_REWRITE_DIAG_FLAG] = "1";
      const rewriter = makeRewriter({ STUB_REPLY: GOOD_REPLY });

      expect(await rewriter.getStatus()).toEqual({
        available: false,
        bin: null,
        reason: "diagnostic-flag",
      });
      expect((await rewriter.rewrite(RAMBLE)).reason).toBe("disabled");
      expect(fs.existsSync(logPath)).toBe(false);
    });
  });

  describe("a missing binary", () => {
    it("is reported by both entry points without spawning", async () => {
      const missing = path.join(dir, "definitely-not-a-real-claude.exe");
      const rewriter = new AgentPromptRewriter({
        claudeBin: missing,
        env: stubEnv({ STUB_REPLY: GOOD_REPLY }),
      });

      expect(await rewriter.getStatus()).toEqual({
        available: false,
        bin: missing,
        reason: "not-found",
      });

      const result = await rewriter.rewrite(RAMBLE);
      expect(result.ok).toBe(false);
      expect(result.reason).toBe("not-found");
      expect(result.message).toContain(missing);
      expect(fs.existsSync(logPath)).toBe(false);
    });
  });
});
