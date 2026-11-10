import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  NarratorAskServer,
  readQuestion,
  ADDRESS_FILE,
  ALLOW_RULE,
  BRIDGE_FILE,
  SERVER_NAME,
} = require("../../../src/helpers/narrator/askServer");

const BRIDGE = path.resolve(__dirname, "../../../src/helpers/narrator/askByVoiceMcp.cjs");
const SESSION = "11111111-2222-4333-8444-555555555555";
const QUESTION = {
  question: "Merge PR 65 now?",
  choices: ["Merge it", "Not now"],
  chat: "Export fix",
};

type Reply = { id?: number; result?: any; error?: any };

/** The bridge as Claude Code runs it: a child process spoken to in JSON lines. */
function startBridge(env: Record<string, string>) {
  const child = spawn(process.execPath, [BRIDGE], {
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  }) as ChildProcessWithoutNullStreams;
  const waiting = new Map<number, (reply: Reply) => void>();
  let buffer = "";
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      const reply = JSON.parse(line) as Reply;
      waiting.get(reply.id as number)?.(reply);
    }
  });
  let next = 1;
  const send = (message: object) => child.stdin.write(`${JSON.stringify(message)}\n`);
  const request = (method: string, params: object = {}) => {
    const id = next++;
    const reply = new Promise<Reply>((resolve) => waiting.set(id, resolve));
    send({ jsonrpc: "2.0", id, method, params });
    return { id, reply };
  };
  const call = async (args: object) => {
    const { reply } = request("tools/call", { name: "ask_by_voice", arguments: args });
    const { result } = await reply;
    return { result, answer: result.isError ? null : JSON.parse(result.content[0].text) };
  };
  return { child, send, request, call };
}

function post(
  port: number,
  { token, body = QUESTION, headers = {} }: { token: string; body?: object; headers?: object }
) {
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: "/ask",
        method: "POST",
        agent: false,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          ...headers,
        },
      },
      (res) => {
        let text = "";
        res.on("data", (chunk) => (text += chunk));
        res.on("end", () => resolve({ status: res.statusCode as number, body: JSON.parse(text) }));
      }
    );
    req.on("error", reject);
    req.end(data);
  });
}

describe("ask_by_voice's question check", () => {
  it("takes one line, 1 to 4 different choices and a short chat name", () => {
    expect(
      readQuestion({ ...QUESTION, question: "Merge\n PR 65   now?", sessionId: SESSION })
    ).toEqual({
      value: { ...QUESTION, sessionId: SESSION, cwd: "" },
    });
    for (const bad of [
      { ...QUESTION, question: "" },
      { ...QUESTION, question: "x".repeat(301) },
      { ...QUESTION, choices: [] },
      { ...QUESTION, choices: ["a", "b", "c", "d", "e"] },
      { ...QUESTION, choices: ["Merge it", "merge it"] },
      { ...QUESTION, choices: ["ok", ""] },
      { ...QUESTION, choices: "Merge it" },
      { ...QUESTION, chat: "" },
      { ...QUESTION, chat: "x".repeat(61) },
    ]) {
      expect(readQuestion(bad).error).toEqual(expect.any(String));
    }
    // A session id that is not one is dropped, not trusted.
    expect(readQuestion({ ...QUESTION, sessionId: "../x" }).value.sessionId).toBeNull();
  });
});

describe("ask_by_voice end to end", () => {
  let dir: string;
  let server: any;
  let asked: any[];
  let answer: (question: any, opts: { signal: AbortSignal }) => Promise<object>;
  let bridges: ReturnType<typeof startBridge>[];

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-ask-"));
    asked = [];
    bridges = [];
    answer = async () => ({ answer: "Merge it" });
    server = new NarratorAskServer({
      dataDir: dir,
      ask: (question: any, opts: { signal: AbortSignal }) => {
        asked.push(question);
        return answer(question, opts);
      },
    });
  });
  afterEach(async () => {
    for (const bridge of bridges) bridge.child.kill();
    await server.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** Claude Code's folder, here empty: no record of running sessions unless a test writes one. */
  const claudeDir = () => path.join(dir, "claude");

  const bridge = (env: Record<string, string> = {}) => {
    const started = startBridge({
      PT_NARRATOR_ASK_FILE: path.join(dir, ADDRESS_FILE),
      CLAUDE_CODE_SESSION_ID: SESSION,
      CLAUDE_CONFIG_DIR: claudeDir(),
      ...env,
    });
    bridges.push(started);
    return started;
  };

  /** Claude Code's record of its running process, for the process that starts the bridge: this one. */
  const recordSession = (entry: object | string) => {
    fs.mkdirSync(path.join(claudeDir(), "sessions"), { recursive: true });
    fs.writeFileSync(
      path.join(claudeDir(), "sessions", `${process.pid}.json`),
      typeof entry === "string" ? entry : JSON.stringify(entry)
    );
  };

  it("lists exactly one tool, ask_by_voice, that says a pick is never consent", async () => {
    const { reply } = bridge().request("tools/list");
    const { result } = await reply;
    expect(result.tools.map((tool: { name: string }) => tool.name)).toEqual(["ask_by_voice"]);
    const [tool] = result.tools;
    expect(tool.inputSchema.required).toEqual(["question", "choices", "chat"]);
    expect(tool.inputSchema.properties.choices).toMatchObject({ minItems: 1, maxItems: 4 });
    expect(tool.description).toMatch(/narrator mode/);
    expect(tool.description).toMatch(/never consent to push, merge, post, release/);
    expect(tool.description).toMatch(/never approves a tool/);
    // The permission rule the Narrator page shows names this very tool.
    expect(ALLOW_RULE).toBe(`mcp__${SERVER_NAME}__${tool.name}`);
  });

  it("names the conversation the call comes from, which /clear moves to a new session id", async () => {
    await server.start();
    // After /clear, Claude Code's record of the process names the new conversation,
    // while the bridge's environment still holds the one it started in.
    const cleared = "99999999-8888-4777-8666-555555555555";
    recordSession({ pid: process.pid, sessionId: cleared, status: "busy" });
    await bridge().call(QUESTION);
    expect(asked.map((question) => question.sessionId)).toEqual([cleared]);
  });

  it("keeps the session id it started with when Claude Code's record is not its parent's", async () => {
    await server.start();
    const other = "99999999-8888-4777-8666-555555555555";
    // Another process's record, a cut-off record, and a record without a session id.
    for (const entry of [
      { pid: process.pid + 1, sessionId: other },
      `{"pid":${process.pid},"sessionId":"${other.slice(0, 10)}`,
      { pid: process.pid, sessionId: "../x" },
    ]) {
      recordSession(entry);
      await bridge().call(QUESTION);
    }
    expect(asked.map((question) => question.sessionId)).toEqual([SESSION, SESSION, SESSION]);
  });

  it("hands the chat the app's own words when the question could not be said", async () => {
    await server.start();
    const why = "PrivateTranscribe's Danish voice is not downloaded, so the question was not said.";
    answer = async () => ({ answer: null, reason: "not_active", error: why });
    const { result, answer: got } = await bridge().call(QUESTION);
    expect(got).toBeNull();
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain(why);
  });

  it("returns not_active at once when the app is not running", async () => {
    const started = Date.now();
    const { answer: got } = await bridge().call(QUESTION);
    expect(got).toEqual({ answer: null, reason: "not_active" });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("carries the question, the chat's session id and the pick between the chat and the app", async () => {
    await server.start();
    const { answer: got } = await bridge().call(QUESTION);
    expect(got).toEqual({ answer: "Merge it" });
    expect(asked).toEqual([{ ...QUESTION, sessionId: SESSION, cwd: expect.any(String) }]);
  });

  it("returns every reason the app gives, and only the documented keys", async () => {
    await server.start();
    for (const reason of ["no_answer", "no_match", "cancelled", "not_active"]) {
      answer = async () => ({ answer: null, reason, extra: "dropped" });
      expect((await bridge().call(QUESTION)).answer).toEqual({ answer: null, reason });
    }
  });

  it("tells the chat what is wrong with a question the app refuses", async () => {
    await server.start();
    const { result } = await bridge().call({ ...QUESTION, choices: ["a", "b", "c", "d", "e"] });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/choices must be 1 to 4/);
    expect(asked).toEqual([]);
  });

  it("returns not_active once the app has quit, and skips an address its quit left behind", async () => {
    await server.start();
    const saved = JSON.parse(fs.readFileSync(path.join(dir, ADDRESS_FILE), "utf8"));
    await server.stop();
    expect(fs.existsSync(path.join(dir, ADDRESS_FILE))).toBe(false);
    expect((await bridge().call(QUESTION)).answer).toEqual({ answer: null, reason: "not_active" });
    // A crash leaves the file, and another program may take its port since: that address is never used.
    const squatter = http.createServer((_req, res) =>
      res.end(JSON.stringify({ answer: "Merge it" }))
    );
    await new Promise<void>((resolve) => squatter.listen(0, "127.0.0.1", () => resolve()));
    const port = (squatter.address() as { port: number }).port;
    fs.writeFileSync(
      path.join(dir, ADDRESS_FILE),
      JSON.stringify({ ...saved, port, pid: 999_999 })
    );
    try {
      expect((await bridge().call(QUESTION)).answer).toEqual({
        answer: null,
        reason: "not_active",
      });
    } finally {
      squatter.close();
    }
  });

  it("stops the question when Claude Code cancels the call", async () => {
    await server.start();
    let aborted = false;
    answer = (_question, { signal }) =>
      new Promise((resolve) => {
        signal.addEventListener("abort", () => {
          aborted = true;
          resolve({ answer: null, reason: "no_answer" });
        });
      });
    const started = bridge();
    const { id, reply } = started.request("tools/call", {
      name: "ask_by_voice",
      arguments: QUESTION,
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    started.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id } });
    const { result } = await reply;
    expect(JSON.parse(result.content[0].text)).toEqual({ answer: null, reason: "cancelled" });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(aborted).toBe(true);
  });

  it("listens on 127.0.0.1 only and lets in nothing without the token, or from a browser", async () => {
    const { port } = await server.start();
    const { token } = JSON.parse(fs.readFileSync(path.join(dir, ADDRESS_FILE), "utf8"));
    expect(server.server.address().address).toBe("127.0.0.1");
    expect((await post(port, { token: "wrong" })).status).toBe(401);
    expect((await post(port, { token, headers: { Origin: "https://example.com" } })).status).toBe(
      403
    );
    expect((await post(port, { token, headers: { Host: `evil.example:${port}` } })).status).toBe(
      403
    );
    expect(asked).toEqual([]);
    expect(await post(port, { token })).toEqual({ status: 200, body: { answer: "Merge it" } });
  });

  it("keeps a new run open, and its address, when it starts while the old one is still stopping", async () => {
    const first = server.start();
    const stopping = server.stop();
    const { port } = await server.start();
    await stopping;
    await first;
    const saved = JSON.parse(fs.readFileSync(path.join(dir, ADDRESS_FILE), "utf8"));
    expect(saved.port).toBe(port);
    expect(server.running).toBe(true);
    expect(await post(port, { token: saved.token })).toEqual({
      status: 200,
      body: { answer: "Merge it" },
    });
    // The stopped run's server is closed; an empty token never gets in.
    expect((await post(port, { token: "" })).status).toBe(401);
  });

  it("copies its bridge next to the address, so one Claude Code line works for every install", async () => {
    await server.start();
    expect(fs.readFileSync(path.join(dir, BRIDGE_FILE), "utf8")).toBe(
      fs.readFileSync(BRIDGE, "utf8")
    );
    // That copy finds the app through the address beside it, with no setting.
    const copy = spawn(process.execPath, [path.join(dir, BRIDGE_FILE)], {
      env: { ...process.env, PT_NARRATOR_ASK_FILE: "", APPDATA: path.join(dir, "elsewhere") },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const line = await new Promise<string>((resolve) => {
      copy.stdout.once("data", (chunk) => resolve(chunk.toString("utf8")));
      copy.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "ask_by_voice", arguments: QUESTION } })}\n`
      );
    });
    copy.kill();
    expect(JSON.parse(JSON.parse(line).result.content[0].text)).toEqual({ answer: "Merge it" });
  });
});
