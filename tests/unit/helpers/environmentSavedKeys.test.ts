/**
 * The API keys a user saves in the app stay inside the app.
 * @module tests/unit/helpers/environmentSavedKeys
 *
 * Converse and Agent Mode run the user's own Claude Code, and every command
 * Converse's agent runs in the project folder inherits its environment. The
 * keys saved in the app must not be in that environment, while a key the user
 * set in Windows for their own projects reaches it, as it does in a terminal.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const EnvironmentManager = require("../../../src/helpers/environment");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ConverseAgent } = require("../../../src/helpers/converseAgent");
const {
  AgentPromptRewriter,
  AGENT_REWRITE_DIAG_FLAG,
  // eslint-disable-next-line @typescript-eslint/no-var-requires
} = require("../../../src/helpers/agentPromptRewriter");

const SECRET_KEYS = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GEMINI_API_KEY",
  "GROQ_API_KEY",
  "CUSTOM_TRANSCRIPTION_API_KEY",
  "CUSTOM_REASONING_API_KEY",
];
const savedValue = (key: string) => `test-only-saved-${key}`;
const USERS_OWN = "test-only-users-own";

/** Stands in for `claude`: records which of the six keys it got, in any case, then exits. */
const STUB_SOURCE = `
const fs = require("node:fs");
const keys = new Set(${JSON.stringify(SECRET_KEYS)});
const seen = {};
for (const [key, value] of Object.entries(process.env)) {
  if (keys.has(key.toUpperCase())) seen[key] = value;
}
fs.writeFileSync(process.env.STUB_LOG, JSON.stringify(seen));
`;

const onlySecretKeys = (env: Record<string, string | undefined>) =>
  Object.fromEntries(Object.entries(env).filter(([key]) => SECRET_KEYS.includes(key.toUpperCase())));

describe("Saved API keys stay inside the app", () => {
  let dir: string;
  let userData: string;
  const original = new Map<string, string | undefined>();
  const setEnv = (key: string, value: string | undefined) => {
    if (!original.has(key)) original.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };

  const runtime = () => ({
    app: { getPath: () => userData },
    safeStorage: {
      isEncryptionAvailable: () => true,
      // Reversible stand-in for the OS keychain.
      encryptString: (plain: string) => Buffer.from(`enc:${plain}`, "utf8"),
      decryptString: (buf: Buffer) => buf.toString("utf8").slice(4),
    },
  });

  const storePath = () => path.join(userData, "keys.enc");
  /** keys.enc as the app writes it, holding these saved keys. */
  const writeStore = (keys: string[]) => {
    const store = Object.fromEntries(keys.map((key) => [key, savedValue(key)]));
    fs.writeFileSync(storePath(), `enc:${JSON.stringify(store)}`);
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-saved-keys-"));
    userData = path.join(dir, "userData");
    fs.mkdirSync(userData);
    // Present and empty, so a developer's own .env is never the fallback.
    fs.writeFileSync(path.join(userData, ".env"), "");
    writeStore(SECRET_KEYS);

    for (const key of SECRET_KEYS) setEnv(key, undefined);
    setEnv(AGENT_REWRITE_DIAG_FLAG, undefined);
    // A key the user set in Windows for their own projects, before the app starts.
    setEnv("OPENAI_API_KEY", USERS_OWN);
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    for (const [key, value] of original) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    original.clear();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("gives the app its saved keys, ahead of the user's own", () => {
    const manager = new EnvironmentManager(runtime());

    expect([
      manager.getOpenAIKey(),
      manager.getAnthropicKey(),
      manager.getGeminiKey(),
      manager.getGroqKey(),
      manager.getCustomTranscriptionKey(),
      manager.getCustomReasoningKey(),
    ]).toEqual(SECRET_KEYS.map(savedValue));
  });

  it("leaves process.env with the user's own key only, also after a save", () => {
    const manager = new EnvironmentManager(runtime());
    manager.saveGeminiKey("test-only-saved-later");

    expect(onlySecretKeys(process.env)).toEqual({ OPENAI_API_KEY: USERS_OWN });
    expect(manager.getGeminiKey()).toBe("test-only-saved-later");
  });

  it("falls back to the user's own key when the app has none saved", () => {
    writeStore(SECRET_KEYS.filter((key) => key !== "OPENAI_API_KEY"));

    expect(new EnvironmentManager(runtime()).getOpenAIKey()).toBe(USERS_OWN);
  });

  it("never copies the user's own key into keys.enc", () => {
    writeStore(SECRET_KEYS.filter((key) => key !== "OPENAI_API_KEY"));
    new EnvironmentManager(runtime()).saveGroqKey("test-only-saved-later");

    const store = fs.readFileSync(storePath(), "utf8");
    expect(store).toContain("test-only-saved-later");
    expect(store).not.toContain(USERS_OWN);
  });

  it("starts Converse's CLI with the user's own key and none the app saved", async () => {
    const manager = new EnvironmentManager(runtime());
    // A key saved while the app runs stays inside it too.
    manager.saveGroqKey("test-only-saved-later");

    const stub = path.join(dir, "claude-stub.cjs");
    const log = path.join(dir, "seen.json");
    fs.writeFileSync(stub, STUB_SOURCE);
    setEnv("PT_CONVERSE_CLAUDE_ARGS", JSON.stringify([stub]));
    setEnv("STUB_LOG", log);

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

    expect(JSON.parse(fs.readFileSync(log, "utf8"))).toEqual({ OPENAI_API_KEY: USERS_OWN });
  });

  it("starts Agent Mode's CLI with the user's own key and none the app saved", async () => {
    new EnvironmentManager(runtime());
    let childEnv: Record<string, string | undefined> = {};
    const spawn = vi.fn((_bin: string, _args: string[], opts: { env: typeof childEnv }) => {
      childEnv = opts.env;
      throw new Error("not starting a real CLI");
    });

    const result = await new AgentPromptRewriter({ claudeBin: process.execPath, spawn }).rewrite(
      "fix the login bug"
    );

    expect(spawn).toHaveBeenCalledOnce();
    expect(result.reason).toBe("spawn-error");
    expect(onlySecretKeys(childEnv)).toEqual({ OPENAI_API_KEY: USERS_OWN });
  });
});
