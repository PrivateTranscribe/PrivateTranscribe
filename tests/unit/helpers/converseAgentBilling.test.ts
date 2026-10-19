import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ConverseAgent, withoutClaudeBillingEnv } = require("../../../src/helpers/converseAgent");

const BILLING_KEYS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
];

/**
 * Stands in for `claude`, pointed at the way tests/e2e points ConverseAgent at
 * one. It records which billing variables (in any case) and which canary it
 * was started with, then exits.
 */
const STUB_SOURCE = `
const fs = require("node:fs");
const watched = new Set(${JSON.stringify([...BILLING_KEYS, "PT_STUB_CANARY"])});
const seen = Object.keys(process.env).filter((key) => watched.has(key.toUpperCase()));
fs.writeFileSync(process.env.STUB_LOG, JSON.stringify(seen));
`;

describe("Converse runs the CLI on the user's Claude Code login", () => {
  it("strips the billing variables in any case and keeps the rest", () => {
    const base = {
      PATH: "keep",
      CLAUDE_CODE_OAUTH_TOKEN: "test-only",
      ANTHROPIC_API_KEY: "test-only",
      anthropic_auth_token: "test-only",
      Anthropic_Base_Url: "https://example.invalid",
      CLAUDE_CODE_USE_BEDROCK: "1",
      CLAUDE_CODE_USE_VERTEX: "1",
      CLAUDE_CODE_USE_FOUNDRY: "1",
    };
    expect(withoutClaudeBillingEnv(base)).toEqual({
      PATH: "keep",
      CLAUDE_CODE_OAUTH_TOKEN: "test-only",
    });
    expect(base.ANTHROPIC_API_KEY).toBe("test-only");
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

    it("does not hand the app's Anthropic key or cloud routing to the CLI", async () => {
      const stub = path.join(dir, "claude-stub.cjs");
      const log = path.join(dir, "seen.json");
      fs.writeFileSync(stub, STUB_SOURCE);
      setEnv("PT_CONVERSE_CLAUDE_ARGS", JSON.stringify([stub]));
      setEnv("STUB_LOG", log);
      setEnv("PT_STUB_CANARY", "kept");
      // What environment.js does with the key saved in keys.enc.
      for (const key of BILLING_KEYS) setEnv(key, "test-only");
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

      expect(JSON.parse(fs.readFileSync(log, "utf8"))).toEqual(["PT_STUB_CANARY"]);
    });
  });
});
