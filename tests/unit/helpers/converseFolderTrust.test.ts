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

  /** Move a file's modified time so "changed since trust" does not depend on clock speed. */
  const touch = (file: string, offsetMs: number) => {
    const at = new Date(fs.statSync(file).mtimeMs + offsetMs);
    fs.utimesSync(file, at, at);
  };

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
    expect(check.files.map((f: { file: string }) => f.file)).toEqual([
      ".claude/settings.json",
      ".claude/settings.local.json",
      ".mcp.json",
      "CLAUDE.md",
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
    const settings = write(".claude/settings.json");
    trustFolder(project, checkFolderTrust(project, { storePath }).files, { storePath });

    touch(settings, 60_000);
    const check = checkFolderTrust(project, { storePath });
    expect(check.needsTrust).toBe(true);
    expect(check.files[0]).toMatchObject({ file: ".claude/settings.json", status: "changed" });
  });

  it("trusts only what the prompt showed, not a change made before the click", () => {
    const settings = write(".claude/settings.json");
    const shown = checkFolderTrust(project, { storePath }).files;
    touch(settings, 60_000);

    const after = trustFolder(project, shown, { storePath });
    expect(after.needsTrust).toBe(true);
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
