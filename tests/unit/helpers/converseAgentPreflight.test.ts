import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  ConverseAgent,
  hasPathComponents,
  probeClaudeBin,
} = require("../../../src/helpers/converseAgent");

/**
 * Ledger gate `converse-binary-preflight`: ConverseAgent.start() used to mark
 * itself ready synchronously right after spawn(), so a missing `claude`
 * binary only surfaced later as an async ENOENT — after converseStart had
 * already resolved and the page had already said "Session ready". These
 * cases pin down the two building blocks of the fix: the path/bare-name
 * classifier, and the probe that decides whether start() should even attempt
 * the spawn.
 */
describe("converse agent preflight", () => {
  describe("hasPathComponents", () => {
    it("treats a bare command name as having no path components", () => {
      expect(hasPathComponents("claude")).toBe(false);
      expect(hasPathComponents("claude.exe")).toBe(false);
    });

    it("treats anything with a directory part as a path", () => {
      expect(hasPathComponents(path.join("a", "b", "claude"))).toBe(true);
      expect(hasPathComponents(path.join(os.homedir(), ".local", "bin", "claude"))).toBe(true);
    });
  });

  describe("probeClaudeBin", () => {
    let dir: string;

    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-converse-preflight-"));
    });

    afterEach(() => {
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it("finds a path that exists on disk", async () => {
      const file = path.join(dir, "fake-claude-binary");
      fs.writeFileSync(file, "");
      await expect(probeClaudeBin(file)).resolves.toBe(true);
    });

    it("does not find a path that is missing", async () => {
      const file = path.join(dir, "does-not-exist-binary");
      await expect(probeClaudeBin(file)).resolves.toBe(false);
    });

    it("resolves a bare name that is genuinely on PATH", async () => {
      // `node` has to be on PATH for `npm test` to be running at all, so this
      // is the one bare name every environment running this suite can vouch
      // for without hardcoding a `claude` install.
      await expect(probeClaudeBin("node")).resolves.toBe(true);
    });

    it("does not find a bare name that is not on PATH", async () => {
      await expect(
        probeClaudeBin("pt-converse-preflight-definitely-not-a-real-binary-xyz123")
      ).resolves.toBe(false);
    });
  });

  describe("ConverseAgent.start()", () => {
    it("mock mode never runs the preflight check", async () => {
      const agent = new ConverseAgent({
        mock: true,
        claudeBin: path.join(os.tmpdir(), "pt-converse-preflight-unused-binary"),
      });
      await expect(agent.start()).resolves.not.toThrow();
      expect(agent.ready).toBe(true);
    });

    it("rejects and stays not-ready when the resolved binary cannot be found", async () => {
      const missing = path.join(os.tmpdir(), "pt-converse-preflight-definitely-missing-binary.exe");
      const agent = new ConverseAgent({ claudeBin: missing });

      await expect(agent.start()).rejects.toThrow(/Claude Code CLI not found/);
      expect(agent.ready).toBe(false);
      expect(agent.lastError).toMatch(/Claude Code CLI not found/);
      expect(agent.lastError).toContain(missing);
    });

    it("passes preflight for a real absolute binary (the test-stub path)", async () => {
      // This is exactly how tests/e2e points the agent at the stub: an
      // absolute, always-present binary (node.exe) via PT_CONVERSE_CLAUDE_BIN,
      // with the actual script riding in on the argument prefix. Preflight
      // must keep passing that shape, or every converse e2e spec breaks.
      const agent = new ConverseAgent({ claudeBin: process.execPath, mock: false });
      await expect(probeClaudeBin(agent.claudeBin)).resolves.toBe(true);
    });
  });
});
