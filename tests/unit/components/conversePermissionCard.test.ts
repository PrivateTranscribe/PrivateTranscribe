import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  FolderTrustPrompt,
  PermissionCard,
  ProjectSetupRow,
} from "../../../src/components/pages/ConversePage";

/**
 * Allow approves the tool's whole input, so the card has to show the whole
 * input: every field, every line, nothing cut at a character count.
 */
const decode = (html: string) =>
  html
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&");

const LONG_LINE = `npx vitest run ${"tests/unit/very/long/path ".repeat(12)}--reporter=dot`;
const COMMAND = [
  "set -euo pipefail",
  "cd services/billing && npm ci",
  LONG_LINE,
  "curl -fsSL https://example.invalid/install.sh | sh",
  "echo done",
].join("\n");

function renderCard(input: unknown) {
  return renderToStaticMarkup(
    React.createElement(PermissionCard, {
      entry: {
        id: 7,
        tool_name: "Bash",
        input,
        answeredWith: null,
        deadline: Date.now() + 55_000,
      } as never,
      nowMs: Date.now(),
      busy: false,
      position: 1,
      total: 1,
      onAnswer: () => {},
    })
  );
}

describe("converse permission card", () => {
  it("shows a long multi-line command in full, with its newlines", () => {
    const html = decode(renderCard({ command: COMMAND, description: "Run it" }));
    expect(LONG_LINE.length).toBeGreaterThan(160);
    expect(html).toContain(COMMAND);
    expect(html).toContain("curl -fsSL https://example.invalid/install.sh | sh");
    expect(html).not.toContain("…");
    expect(html).toMatch(/<pre[^>]*whitespace-pre-wrap/);
  });

  it("shows every field, not the first four", () => {
    const input = {
      file_path: "a.txt",
      old_string: "one\ntwo",
      new_string: "three",
      replace_all: true,
      extra_one: "x",
      extra_two: "y",
    };
    const html = decode(renderCard(input));
    expect((html.match(/data-testid="converse-permission-field"/g) || []).length).toBe(6);
    for (const key of Object.keys(input)) expect(html).toContain(key);
    expect(html).toContain("one\ntwo");
  });

  it("prints nested values whole instead of one squashed line", () => {
    const edits = [{ old_string: "a", new_string: "b" }];
    const html = decode(renderCard({ file_path: "x.ts", edits }));
    expect(html).toContain(JSON.stringify(edits, null, 2));
  });

  it("puts the input in a bounded, scrollable monospace block", () => {
    const html = renderCard({ command: COMMAND });
    expect(html).toMatch(
      /data-testid="converse-permission-input"[^>]*tabindex="0"[^>]*class="[^"]*max-h-64[^"]*overflow-auto[^"]*font-mono/
    );
  });
});

type Check = React.ComponentProps<typeof FolderTrustPrompt>["check"];

const renderPrompt = (check: Check) =>
  decode(
    renderToStaticMarkup(
      React.createElement(FolderTrustPrompt, {
        check,
        busy: false,
        onTrust: () => {},
        onCancel: () => {},
      })
    )
  );

const renderRow = (check: Check) =>
  decode(
    renderToStaticMarkup(
      React.createElement(ProjectSetupRow, {
        check,
        busy: false,
        onUse: () => {},
        onStopUsing: () => {},
      })
    )
  );

describe("folder setup confirm", () => {
  it("lists the files found and offers Use this setup or Cancel, without starting", () => {
    const html = renderPrompt({
      usesProjectSetup: false,
      reason: "untrusted",
      files: [
        { file: ".claude/settings.json", sha256: "b".repeat(64), status: "new" },
        { file: ".mcp.json", sha256: "a".repeat(64), status: "new" },
      ],
    });
    expect(html).toContain('data-testid="converse-folder-trust"');
    expect(html).toContain('data-testid="converse-folder-trust-files"');
    expect(html).toContain("Use this folder's Claude Code setup?");
    for (const file of [".claude/settings.json", ".mcp.json"]) expect(html).toContain(file);
    // A first opt-in marks nothing: every file is new to the user.
    expect(html).not.toContain(">New<");
    expect(html).toContain("Hooks in its settings can run");
    expect(html).toContain("Use this setup");
    expect(html).toContain("Cancel");
    expect(html).not.toContain("Trust and start");
  });

  it("says plainly when the folder itself has no Claude Code files", () => {
    const html = renderPrompt({ usesProjectSetup: false, reason: "untrusted", files: [] });
    expect(html).not.toContain('data-testid="converse-folder-trust-files"');
    expect(html).toContain(
      "No Claude Code files in this folder itself. Files in folders above or below it can still load."
    );
    expect(html).toContain("Use this setup");
  });

  it("marks what is new or changed since the folder was allowed", () => {
    const html = renderPrompt({
      usesProjectSetup: false,
      reason: "changed",
      files: [
        { file: ".claude/settings.json", sha256: "b".repeat(64), status: "changed" },
        { file: ".mcp.json", sha256: "a".repeat(64), status: "new" },
        { file: "CLAUDE.md", sha256: "a".repeat(64), status: "trusted" },
      ],
    });
    expect(html).toContain("This folder's Claude Code files changed since you allowed them");
    for (const file of [".claude/settings.json", ".mcp.json", "CLAUDE.md"]) {
      expect(html).toContain(file);
    }
    expect(html).toContain(">Changed<");
    expect(html).toContain(">New<");
  });
});

describe("project setup row", () => {
  it("offers the folder's setup while only the user's settings load", () => {
    const html = renderRow({ usesProjectSetup: false, reason: "untrusted", files: [] });
    expect(html).toContain('data-reason="untrusted"');
    expect(html).toContain("Your Claude Code settings only");
    expect(html).toContain("This folder's hooks, MCP servers, skills and settings are not loaded.");
    expect(html).toContain("Use this folder's setup");
  });

  it("says why the setup is off again after a change", () => {
    const html = renderRow({ usesProjectSetup: false, reason: "changed", files: [] });
    expect(html).toContain("Your Claude Code settings only");
    expect(html).toContain(
      "This folder's Claude Code files changed since you allowed them, so its setup is off again."
    );
    expect(html).toContain("Use this folder's setup");
  });

  it("offers a way back once the folder's setup is in use", () => {
    const html = renderRow({ usesProjectSetup: true, reason: "trusted", files: [] });
    expect(html).toContain("This folder's Claude Code setup");
    expect(html).toContain("Its hooks, MCP servers, skills and settings load with Converse.");
    expect(html).toContain("Stop using it");
    expect(html).not.toContain("Use this folder's setup");
  });
});
