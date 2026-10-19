import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ConverseAgent, withoutClaudeBillingEnv } = require("../../../src/helpers/converseAgent");

/** The user's own Claude Code setup, which acts the same in --print as in a terminal. */
const SETUP_KEYS = [
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_USE_VERTEX",
];

/**
 * Stands in for `claude`, pointed at the way tests/e2e points ConverseAgent at
 * one. It records which Anthropic variables (in any case) and which canary it
 * was started with, then exits.
 */
const STUB_SOURCE = `
const fs = require("node:fs");
const watched = new Set(${JSON.stringify(["ANTHROPIC_API_KEY", ...SETUP_KEYS, "PT_STUB_CANARY"])});
const seen = Object.keys(process.env).filter((key) => watched.has(key.toUpperCase())).sort();
fs.writeFileSync(process.env.STUB_LOG, JSON.stringify(seen));
`;

describe("Converse runs the CLI on the user's Claude Code login", () => {
  it("strips the API key in any case and keeps the user's own Claude Code setup", () => {
    const setup = {
      PATH: "keep",
      CLAUDE_CODE_OAUTH_TOKEN: "test-only",
      ANTHROPIC_AUTH_TOKEN: "test-only",
      ANTHROPIC_BASE_URL: "https://example.invalid",
      CLAUDE_CODE_USE_BEDROCK: "1",
      CLAUDE_CODE_USE_VERTEX: "1",
      CLAUDE_CODE_USE_FOUNDRY: "1",
    };
    expect(withoutClaudeBillingEnv({ ...setup, ANTHROPIC_API_KEY: "test-only" })).toEqual(setup);
    expect(withoutClaudeBillingEnv({ ...setup, Anthropic_Api_Key: "test-only" })).toEqual(setup);
  });

  describe("start()", () => {
    let dir: string;
    const saved = new Map<string, string | undefined>();
    const setEnv = (key: string, value: string) => {
      if (!saved.has(key)) saved.set(key, process.env[key]);
      process.env[key] = value;
    };

    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-converse-billing-"));
    });

    afterEach(() => {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      saved.clear();
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it("does not hand an Anthropic API key to the CLI but keeps the user's setup", async () => {
      const stub = path.join(dir, "claude-stub.cjs");
      const log = path.join(dir, "seen.json");
      fs.writeFileSync(stub, STUB_SOURCE);
      setEnv("PT_CONVERSE_CLAUDE_ARGS", JSON.stringify([stub]));
      setEnv("STUB_LOG", log);
      setEnv("PT_STUB_CANARY", "kept");
      // A key in the user's own environment, which --print would bill without asking.
      setEnv("ANTHROPIC_API_KEY", "test-only");
      for (const key of SETUP_KEYS) setEnv(key, "test-only");
      vi.spyOn(console, "log").mockImplementation(() => {});

      const agent = new ConverseAgent({
        claudeBin: process.execPath,
        cwd: dir,
        trustStorePath: path.join(dir, "trust.json"),
      });
      try {
        await agent.start();
        const child = agent.proc;
        await new Promise((resolve) => child.once("exit", resolve));
      } finally {
        agent.stop();
      }

      expect(JSON.parse(fs.readFileSync(log, "utf8"))).toEqual([...SETUP_KEYS, "PT_STUB_CANARY"]);
    });
  });
});
