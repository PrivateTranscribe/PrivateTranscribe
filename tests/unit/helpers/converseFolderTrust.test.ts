import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  ConverseAgent,
  checkFolderTrust,
  trustFolder,
  FOLDER_TRUST_REQUIRED_MESSAGE,
} = require("../../../src/helpers/converseAgent");

/**
 * Claude Code in --print mode loads a folder's own settings, hooks, MCP servers
 * and CLAUDE.md without its interactive trust prompt, so the app asks instead.
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

  it("starts as today when the folder has none of the files", () => {
    fs.writeFileSync(path.join(project, "README.md"), "# hi");
    const check = checkFolderTrust(project, { storePath });
    expect(check.needsTrust).toBe(false);
    expect(check.reason).toBe("no-config");
    expect(check.files).toEqual([]);
  });

  it("asks, naming every file found, before the first start", () => {
    write(".claude/settings.json", '{"hooks":{}}');
    write(".claude/settings.local.json");
    write(".mcp.json");
    write("CLAUDE.md", "# rules");

    const check = checkFolderTrust(project, { storePath });
    expect(check.needsTrust).toBe(true);
    expect(check.reason).toBe("untrusted");
    expect(names(check)).toEqual([
      ".mcp.json",
      "CLAUDE.md",
      ".claude/settings.json",
      ".claude/settings.local.json",
    ]);
  });

  it("does not ask again once trusted and unchanged, and keeps the decision outside the folder", () => {
    write(".mcp.json");
    const shown = checkFolderTrust(project, { storePath });
    const after = trustFolder(project, shown.files, { storePath });

    expect(after.needsTrust).toBe(false);
    expect(checkFolderTrust(project, { storePath }).needsTrust).toBe(false);
    expect(fs.existsSync(storePath)).toBe(true);
    expect(fs.readdirSync(project)).toEqual([".mcp.json"]);
  });

  it("asks again when a new file appears after the trust", () => {
    write("CLAUDE.md", "# rules");
    trustFolder(project, checkFolderTrust(project, { storePath }).files, { storePath });

    write(".claude/settings.json", '{"hooks":{"PreToolUse":[]}}');
    const check = checkFolderTrust(project, { storePath });
    expect(check.needsTrust).toBe(true);
    expect(check.reason).toBe("changed");
    const byFile = Object.fromEntries(
      check.files.map((f: { file: string; status: string }) => [f.file, f.status])
    );
    expect(byFile).toEqual({ ".claude/settings.json": "new", "CLAUDE.md": "trusted" });
  });

  it("asks again when a trusted file is modified later", () => {
    write(".claude/settings.json");
    trustFolder(project, checkFolderTrust(project, { storePath }).files, { storePath });

    write(".claude/settings.json", '{"permissions":{"allow":["Bash(*)"]}}');
    const check = checkFolderTrust(project, { storePath });
    expect(check.needsTrust).toBe(true);
    expect(check.files[0]).toMatchObject({ file: ".claude/settings.json", status: "changed" });
  });

  it("asks again when new content keeps the trusted file's modified time", () => {
    const settings = write(".claude/settings.json");
    stampArchiveTime(settings);
    const trustedTime = fs.statSync(settings).mtimeMs;
    trustFolder(project, checkFolderTrust(project, { storePath }).files, { storePath });

    write(".claude/settings.json", '{"hooks":{"SessionStart":[]}}');
    stampArchiveTime(settings);
    expect(fs.statSync(settings).mtimeMs).toBe(trustedTime);
    expect(checkFolderTrust(project, { storePath }).needsTrust).toBe(true);
  });

  it("trusts only what the prompt showed, not a change made before the click", () => {
    write(".claude/settings.json");
    const shown = checkFolderTrust(project, { storePath }).files;
    write(".claude/settings.json", '{"hooks":{}}');

    const after = trustFolder(project, shown, { storePath });
    expect(after.needsTrust).toBe(true);
  });

  it("covers everything Claude Code loads from .claude, and a changed hook script asks again", () => {
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
    expect(check.needsTrust).toBe(true);
    expect(
      check.files.find((f: { file: string }) => f.file === ".claude/hooks/stop.js")
    ).toMatchObject({
      status: "changed",
    });
  });

  it("asks for a folder whose only Claude Code file is AGENTS.md", () => {
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

  it("never trusts a .claude too big to check, and still hashes its settings", () => {
    write(".claude/settings.json", '{"hooks":{}}');
    const many = path.join(project, ".claude", "a");
    fs.mkdirSync(many, { recursive: true });
    for (let i = 0; i < 5001; i++) fs.writeFileSync(path.join(many, `${i}.md`), "");

    const shown = checkFolderTrust(project, { storePath });
    expect(names(shown)[0]).toBe(".claude/settings.json");
    expect(names(shown).at(-1)).toMatch(/too many to check/);
    expect(trustFolder(project, shown.files, { storePath }).needsTrust).toBe(true);
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
    expect(trustFolder(project, shown, { storePath }).needsTrust).toBe(true);
  });

  it("treats the same folder spelled differently as one folder", () => {
    write("CLAUDE.md");
    trustFolder(project, checkFolderTrust(project, { storePath }).files, { storePath });
    const respelled =
      process.platform === "win32" ? `${project.toUpperCase()}\\` : `${project}${path.sep}`;
    expect(checkFolderTrust(respelled, { storePath }).needsTrust).toBe(false);
  });

  it("ConverseAgent.start() refuses an untrusted folder before spawning anything", async () => {
    write(".claude/settings.json", '{"permissions":{"allow":["Bash(*)"]}}');
    const agent = new ConverseAgent({
      cwd: project,
      claudeBin: process.execPath,
      trustStorePath: storePath,
    });

    await expect(agent.start()).rejects.toThrow(FOLDER_TRUST_REQUIRED_MESSAGE);
    await expect(agent.start()).rejects.toThrow(".claude/settings.json");
    expect(agent.proc).toBeNull();
    expect(agent.ready).toBe(false);
  });
});
