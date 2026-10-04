import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const nodeOs = require("node:os");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  ConverseAgent,
  findOnPath,
  resolveClaudeBin,
} = require("../../../src/helpers/converseAgent");

/**
 * A `claude.exe` planted in the project folder must never be what runs: Windows
 * searches the cwd before PATH for a bare name, so the CLI is resolved to an
 * absolute path from PATH directories only, and so is the relay's interpreter.
 */
const EXE = process.platform === "win32" ? "claude.exe" : "claude";

describe("converse claude resolution", () => {
  let root: string;
  let project: string;
  let goodDir: string;
  let emptyHome: string;
  const saved = {
    PATH: process.env.PATH,
    bin: process.env.PT_CONVERSE_CLAUDE_BIN,
    args: process.env.PT_CONVERSE_CLAUDE_ARGS,
  };

  const plant = (dir: string, name = EXE) => {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, name);
    fs.writeFileSync(file, "");
    return file;
  };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "pt-claude-resolve-"));
    project = path.join(root, "project");
    goodDir = path.join(root, "real-bin");
    emptyHome = path.join(root, "home");
    fs.mkdirSync(emptyHome);
    delete process.env.PT_CONVERSE_CLAUDE_BIN;
    delete process.env.PT_CONVERSE_CLAUDE_ARGS;
    // No per-user install, so the PATH search is what decides.
    vi.spyOn(nodeOs, "homedir").mockReturnValue(emptyHome);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env.PATH = saved.PATH;
    if (saved.bin === undefined) delete process.env.PT_CONVERSE_CLAUDE_BIN;
    else process.env.PT_CONVERSE_CLAUDE_BIN = saved.bin;
    if (saved.args === undefined) delete process.env.PT_CONVERSE_CLAUDE_ARGS;
    else process.env.PT_CONVERSE_CLAUDE_ARGS = saved.args;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("skips relative PATH entries and the project folder, and returns an absolute path", () => {
    plant(project);
    const real = plant(goodDir);
    process.env.PATH = [".", "", "relative-bin", project, goodDir].join(path.delimiter);

    const cwd = process.cwd();
    process.chdir(project);
    try {
      expect(findOnPath(EXE, { exclude: [project] })).toBe(real);
      const resolved = resolveClaudeBin(undefined, { cwd: project });
      expect(resolved).toBe(real);
      expect(path.isAbsolute(resolved)).toBe(true);
    } finally {
      process.chdir(cwd);
    }
  });

  it("never falls back to a claude in the project folder when PATH has none", async () => {
    plant(project);
    process.env.PATH = [project, "."].join(path.delimiter);

    const agent = new ConverseAgent({ cwd: project });
    expect(agent.claudeBin).toBe(EXE);
    await expect(agent.start()).rejects.toThrow(`Claude Code CLI not found (tried "${EXE}")`);
    expect(agent.proc).toBeNull();
  });

  it("prefers the per-user install when it exists", () => {
    const userInstall = plant(path.join(emptyHome, ".local", "bin"));
    plant(goodDir);
    process.env.PATH = goodDir;
    expect(resolveClaudeBin(undefined, { cwd: project })).toBe(userInstall);
  });

  it("resolves a bare override name through PATH too", () => {
    const real = plant(
      goodDir,
      process.platform === "win32" ? "pt-claude-stub.exe" : "pt-claude-stub"
    );
    process.env.PATH = goodDir;
    process.env.PT_CONVERSE_CLAUDE_BIN = "pt-claude-stub";
    expect(resolveClaudeBin(undefined, { cwd: project })).toBe(real);
  });

  it("starts the permission relay with an absolute interpreter in Node mode", async () => {
    fs.mkdirSync(project, { recursive: true });
    const noop = path.join(root, "noop-claude.cjs");
    fs.writeFileSync(noop, "process.stdin.resume(); setTimeout(() => process.exit(0), 2000);\n");
    process.env.PT_CONVERSE_CLAUDE_ARGS = JSON.stringify([noop]);

    const agent = new ConverseAgent({
      cwd: project,
      claudeBin: process.execPath,
      permissionRelay: { port: 1, token: "t" },
    });
    try {
      await agent.start();
      const config = JSON.parse(fs.readFileSync(agent.mcpConfigPath, "utf8"));
      const server = config.mcpServers["pt-permissions"];
      expect(server.command).toBe(process.execPath);
      expect(path.isAbsolute(server.command)).toBe(true);
      expect(server.env.ELECTRON_RUN_AS_NODE).toBe("1");
      expect(path.isAbsolute(server.args[0])).toBe(true);
    } finally {
      // The child holds the project folder as its cwd until it has exited.
      const child = agent.proc;
      const exited = child ? new Promise((resolve) => child.once("exit", resolve)) : null;
      agent.stop();
      await exited;
    }
  });
});
