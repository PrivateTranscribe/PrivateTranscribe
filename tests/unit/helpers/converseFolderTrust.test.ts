import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  ConverseAgent,
  checkFolderTrust,
  trustFolder,
  forgetFolder,
} = require("../../../src/helpers/converseAgent");

/**
 * Claude Code in --print mode loads a folder's own settings, hooks, MCP servers
 * and skills without its interactive trust prompt, so Converse starts it on the
 * user's own settings until the user opts the folder in, and again after any of
 * the folder's files change.
 */
describe("converse folder trust", () => {
  let project: string;
  let storeDir: string;
  let storePath: string;

  const write = (rel: string, body = "{}") => {
    const file = path.join(project, ...rel.split("/"));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
    return file;
  };

  /** Stamp a fixed modified time, the way an extracted archive does. */
  const ARCHIVE_TIME = new Date("2026-01-01T00:00:00Z");
  const stampArchiveTime = (file: string) => fs.utimesSync(file, ARCHIVE_TIME, ARCHIVE_TIME);
  const names = (check: { files: { file: string }[] }) => check.files.map((f) => f.file);

  beforeEach(() => {
    project = fs.mkdtempSync(path.join(os.tmpdir(), "pt-trust-project-"));
    storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-trust-store-"));
    storePath = path.join(storeDir, "converse-folder-trust.json");
  });

  afterEach(() => {
    fs.rmSync(project, { recursive: true, force: true });
    fs.rmSync(storeDir, { recursive: true, force: true });
  });

  it("keeps a folder with none of the files on the user's settings until it is opted in", () => {
    fs.writeFileSync(path.join(project, "README.md"), "# hi");
    const check = checkFolderTrust(project, { storePath });
    expect(check.usesProjectSetup).toBe(false);
    expect(check.reason).toBe("untrusted");
    expect(check.files).toEqual([]);
  });

  it("can opt in a folder with no files of its own", () => {
    const after = trustFolder(project, checkFolderTrust(project, { storePath }).files, {
      storePath,
    });
    expect(after).toMatchObject({ usesProjectSetup: true, reason: "trusted", files: [] });
    expect(checkFolderTrust(project, { storePath }).usesProjectSetup).toBe(true);

    write("CLAUDE.md", "# rules");
    const check = checkFolderTrust(project, { storePath });
    expect(check.reason).toBe("changed");
    expect(check.files).toEqual([expect.objectContaining({ file: "CLAUDE.md", status: "new" })]);
  });

  it("forgets an opted-in folder, and leaves other folders alone", () => {
    write(".mcp.json");
    const other = fs.mkdtempSync(path.join(os.tmpdir(), "pt-trust-other-"));
    try {
      trustFolder(project, checkFolderTrust(project, { storePath }).files, { storePath });
      trustFolder(other, [], { storePath });

      const after = forgetFolder(project, { storePath });
      expect(after.usesProjectSetup).toBe(false);
      expect(after.reason).toBe("untrusted");
      expect(checkFolderTrust(project, { storePath }).reason).toBe("untrusted");
      expect(checkFolderTrust(other, { storePath }).usesProjectSetup).toBe(true);
      expect(fs.readdirSync(storeDir)).toEqual(["converse-folder-trust.json"]);

      // Forgetting a folder that was never opted in changes nothing.
      expect(forgetFolder(project, { storePath }).reason).toBe("untrusted");
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });

  it("names every file found before the folder is opted in", () => {
    write(".claude/settings.json", '{"hooks":{}}');
    write(".claude/settings.local.json");
    write(".mcp.json");
    write("CLAUDE.md", "# rules");

    const check = checkFolderTrust(project, { storePath });
    expect(check.usesProjectSetup).toBe(false);
    expect(check.reason).toBe("untrusted");
    expect(names(check)).toEqual([
      ".mcp.json",
      "CLAUDE.md",
      ".claude/settings.json",
      ".claude/settings.local.json",
    ]);
  });

  it("uses the folder's setup once opted in and unchanged, and keeps the decision outside the folder", () => {
    write(".mcp.json");
    const shown = checkFolderTrust(project, { storePath });
    const after = trustFolder(project, shown.files, { storePath });

    expect(after.usesProjectSetup).toBe(true);
    expect(after.reason).toBe("trusted");
    expect(checkFolderTrust(project, { storePath }).usesProjectSetup).toBe(true);
    expect(fs.existsSync(storePath)).toBe(true);
    expect(fs.readdirSync(project)).toEqual([".mcp.json"]);
  });

  it("stops using the folder's setup when a new file appears after the opt-in", () => {
    write("CLAUDE.md", "# rules");
    trustFolder(project, checkFolderTrust(project, { storePath }).files, { storePath });

    write(".claude/settings.json", '{"hooks":{"PreToolUse":[]}}');
    const check = checkFolderTrust(project, { storePath });
    expect(check.usesProjectSetup).toBe(false);
    expect(check.reason).toBe("changed");
    const byFile = Object.fromEntries(
      check.files.map((f: { file: string; status: string }) => [f.file, f.status])
    );
    expect(byFile).toEqual({ ".claude/settings.json": "new", "CLAUDE.md": "trusted" });
  });

  it("stops using the folder's setup when an allowed file is modified later", () => {
    write(".claude/settings.json");
    trustFolder(project, checkFolderTrust(project, { storePath }).files, { storePath });

    write(".claude/settings.json", '{"permissions":{"allow":["Bash(*)"]}}');
    const check = checkFolderTrust(project, { storePath });
    expect(check.usesProjectSetup).toBe(false);
    expect(check.reason).toBe("changed");
    expect(check.files[0]).toMatchObject({ file: ".claude/settings.json", status: "changed" });
  });

  it("notices new content that keeps the allowed file's modified time", () => {
    const settings = write(".claude/settings.json");
    stampArchiveTime(settings);
    const trustedTime = fs.statSync(settings).mtimeMs;
    trustFolder(project, checkFolderTrust(project, { storePath }).files, { storePath });

    write(".claude/settings.json", '{"hooks":{"SessionStart":[]}}');
    stampArchiveTime(settings);
    expect(fs.statSync(settings).mtimeMs).toBe(trustedTime);
    expect(checkFolderTrust(project, { storePath }).usesProjectSetup).toBe(false);
  });

  it("allows only what the confirm showed, not a change made before the click", () => {
    write(".claude/settings.json");
    const shown = checkFolderTrust(project, { storePath }).files;
    write(".claude/settings.json", '{"hooks":{}}');

    const after = trustFolder(project, shown, { storePath });
    expect(after.usesProjectSetup).toBe(false);
    expect(after.reason).toBe("changed");
  });

  it("covers everything Claude Code loads from .claude, and a changed hook script counts", () => {
    write(
      ".claude/settings.json",
      '{"hooks":{"Stop":[{"hooks":[{"command":"node .claude/hooks/stop.js"}]}]}}'
    );
    write(".claude/hooks/stop.js", "// harmless");
    write(".claude/agents/reviewer.md");
    write(".claude/skills/deploy/SKILL.md");
    write(".claude/commands/ship.md");
    write(".claude/rules/style.md");
    write(".claude/worktrees/feature/.claude/settings.json");

    const shown = checkFolderTrust(project, { storePath });
    expect(names(shown)).toEqual([
      ".claude/settings.json",
      ".claude/agents/reviewer.md",
      ".claude/commands/ship.md",
      ".claude/hooks/stop.js",
      ".claude/rules/style.md",
      ".claude/skills/deploy/SKILL.md",
    ]);
    trustFolder(project, shown.files, { storePath });

    write(".claude/hooks/stop.js", "require('child_process').exec('anything')");
    const check = checkFolderTrust(project, { storePath });
    expect(check.usesProjectSetup).toBe(false);
    expect(
      check.files.find((f: { file: string }) => f.file === ".claude/hooks/stop.js")
    ).toMatchObject({
      status: "changed",
    });
  });

  it("lists a folder whose only Claude Code file is AGENTS.md", () => {
    write("AGENTS.md", "# agents");
    expect(names(checkFolderTrust(project, { storePath }))).toEqual(["AGENTS.md"]);
  });

  it("keeps the settings files named when .claude is padded past the listing cap", () => {
    write(".claude/settings.json", '{"hooks":{}}');
    for (let i = 0; i < 520; i++) write(`.claude/a/${String(i).padStart(4, "0")}.md`, "x");

    const listed = names(checkFolderTrust(project, { storePath }));
    expect(listed[0]).toBe(".claude/settings.json");
    expect(listed.at(-1)).toBe(".claude/ (20 more files)");
  });

  it("never allows a .claude too big to check, and still hashes its settings", () => {
    write(".claude/settings.json", '{"hooks":{}}');
    const many = path.join(project, ".claude", "a");
    fs.mkdirSync(many, { recursive: true });
    for (let i = 0; i < 5001; i++) fs.writeFileSync(path.join(many, `${i}.md`), "");

    const shown = checkFolderTrust(project, { storePath });
    expect(names(shown)[0]).toBe(".claude/settings.json");
    expect(names(shown).at(-1)).toMatch(/too many to check/);
    expect(trustFolder(project, shown.files, { storePath }).usesProjectSetup).toBe(false);
  }, 60_000);

  it("finishes on a folder link that loops back into .claude", () => {
    write(".claude/settings.json");
    const claudeDir = path.join(project, ".claude");
    for (const name of ["loop1", "loop2", "loop3", "loop4"]) {
      fs.symlinkSync(claudeDir, path.join(claudeDir, name), "junction");
    }

    const started = Date.now();
    expect(names(checkFolderTrust(project, { storePath }))).toEqual([".claude/settings.json"]);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("ignores a trust record that does not carry content hashes", () => {
    write("CLAUDE.md");
    const shown = checkFolderTrust(project, { storePath }).files.map((f: { file: string }) => ({
      file: f.file,
      mtimeMs: 1,
    }));
    expect(trustFolder(project, shown, { storePath }).usesProjectSetup).toBe(false);
  });

  it("treats the same folder spelled differently as one folder", () => {
    write("CLAUDE.md");
    trustFolder(project, checkFolderTrust(project, { storePath }).files, { storePath });
    const respelled =
      process.platform === "win32" ? `${project.toUpperCase()}\\` : `${project}${path.sep}`;
    expect(checkFolderTrust(respelled, { storePath }).usesProjectSetup).toBe(true);
  });

  describe("ConverseAgent.start()", () => {
    let noop: string;
    const savedArgs = process.env.PT_CONVERSE_CLAUDE_ARGS;

    beforeEach(() => {
      noop = path.join(storeDir, "noop-claude.cjs");
      fs.writeFileSync(noop, "process.stdin.resume(); setTimeout(() => process.exit(0), 5000);\n");
      process.env.PT_CONVERSE_CLAUDE_ARGS = JSON.stringify([noop]);
    });

    afterEach(() => {
      if (savedArgs === undefined) delete process.env.PT_CONVERSE_CLAUDE_ARGS;
      else process.env.PT_CONVERSE_CLAUDE_ARGS = savedArgs;
    });

    /** Start the agent, return the CLI arguments it spawned with, then stop it. */
    const spawnArgs = async (opts: Record<string, unknown> = {}) => {
      const agent = new ConverseAgent({
        cwd: project,
        claudeBin: process.execPath,
        trustStorePath: storePath,
        ...opts,
      });
      try {
        await agent.start();
        expect(agent.ready).toBe(true);
        return {
          args: (agent.proc.spawnargs as string[]).slice(2),
          projectSetup: agent.status().projectSetup,
        };
      } finally {
        // The child holds the project folder as its cwd until it has exited.
        const child = agent.proc;
        const exited = child ? new Promise((resolve) => child.once("exit", resolve)) : null;
        agent.stop();
        await exited;
      }
    };

    const settingSources = (args: string[]) => {
      const at = args.indexOf("--setting-sources");
      return at >= 0 ? args[at + 1] : null;
    };

    it("starts in a folder that was never opted in with the user's settings only", async () => {
      write(".claude/settings.json", '{"permissions":{"allow":["Bash(*)"]}}');
      const { args, projectSetup } = await spawnArgs();
      expect(settingSources(args)).toBe("user");
      expect(projectSetup).toBe("user-only");
    });

    it("loads the folder's setup once opted in, and stops again after a change", async () => {
      write(".claude/settings.json", "{}");
      trustFolder(project, checkFolderTrust(project, { storePath }).files, { storePath });

      const trusted = await spawnArgs();
      expect(trusted.args).not.toContain("--setting-sources");
      expect(trusted.projectSetup).toBe("folder");

      write(".claude/settings.json", '{"hooks":{"SessionStart":[]}}');
      const changed = await spawnArgs();
      expect(settingSources(changed.args)).toBe("user");
      expect(changed.projectSetup).toBe("user-only");
    });

    it("carries the user-only setting on a resumed session too", async () => {
      const { args } = await spawnArgs({ resumeSessionId: "resume-me" });
      expect(args).toContain("--resume");
      expect(args[args.indexOf("--resume") + 1]).toBe("resume-me");
      expect(settingSources(args)).toBe("user");
    });

    it("reports no setup in mock mode, where no CLI starts", async () => {
      const agent = new ConverseAgent({ cwd: project, mock: true, trustStorePath: storePath });
      await agent.start();
      expect(agent.proc).toBeNull();
      expect(agent.status().projectSetup).toBeNull();
    });
  });
});
