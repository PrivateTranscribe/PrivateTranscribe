import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * End-to-end round-trip of the permission relay WITHOUT the claude CLI: the
 * real MCP stdio script is spawned as a child process, spoken to in MCP
 * JSON-RPC exactly the way the CLI does, and the relay answers over real
 * loopback HTTP. What this pins down is the fail-closed contract: everything
 * unexpected — wrong token, unknown tool, no answer — must come back deny.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { ConversePermissionRelay } = require("../../../src/helpers/conversePermissionRelay.js");

const MCP_SCRIPT = path.resolve(__dirname, "../../../src/helpers/conversePermissionMcp.cjs");

type Json = Record<string, unknown>;

function startMcp(env: Record<string, string>) {
  const child = spawn(process.execPath, [MCP_SCRIPT], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...env },
  });

  const pending = new Map<number, (msg: Json) => void>();
  let buf = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const msg = JSON.parse(line) as Json;
      const id = msg.id as number;
      const resolve = pending.get(id);
      if (resolve) {
        pending.delete(id);
        resolve(msg);
      }
    }
  });

  let nextId = 1;
  const request = (method: string, params?: Json): Promise<Json> => {
    const id = nextId++;
    const line = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no reply to ${method}`)), 10_000);
      pending.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      child.stdin.write(line + "\n");
    });
  };
  const notify = (method: string) => {
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method }) + "\n");
  };

  return { child, request, notify };
}

function decisionOf(reply: Json): { behavior: string; message?: string } {
  const result = reply.result as { content: { type: string; text: string }[] };
  return JSON.parse(result.content[0].text);
}

describe("converse permission relay + MCP script", () => {
  const relay = new ConversePermissionRelay();
  let port = 0;
  let token = "";
  let mcp: { child: ChildProcess; request: (m: string, p?: Json) => Promise<Json> };

  beforeAll(async () => {
    const info = await relay.start();
    port = info.port;
    token = info.token;
    const started = startMcp({
      PT_PERMISSION_RELAY_PORT: String(port),
      PT_PERMISSION_RELAY_TOKEN: token,
    });
    mcp = started;
    const init = await started.request("initialize", { protocolVersion: "2024-11-05" });
    expect((init.result as Json).serverInfo).toMatchObject({ name: "pt-permissions" });
    started.notify("notifications/initialized");
  });

  afterAll(() => {
    mcp?.child.kill();
    relay.stop();
  });

  it("lists exactly the approve tool", async () => {
    const reply = await mcp.request("tools/list");
    const tools = (reply.result as { tools: { name: string }[] }).tools;
    expect(tools.map((t) => t.name)).toEqual(["approve"]);
  });

  it("relays a question and returns the armed deny", async () => {
    relay.setAutoAnswer("deny");
    const reply = await mcp.request("tools/call", {
      name: "approve",
      arguments: { tool_name: "Bash", input: { command: "echo hi" }, tool_use_id: "tu_1" },
    });
    const decision = decisionOf(reply);
    expect(decision.behavior).toBe("deny");

    const log = relay.getLog();
    expect(log).toHaveLength(1);
    expect(log[0].tool_name).toBe("Bash");
    expect(log[0].answeredWith).toBe("deny");
  });

  it("relays a question and returns the armed allow with the input echoed", async () => {
    relay.setAutoAnswer("allow");
    const input = { command: "echo again" };
    const reply = await mcp.request("tools/call", {
      name: "approve",
      arguments: { tool_name: "Bash", input, tool_use_id: "tu_2" },
    });
    const decision = decisionOf(reply) as { behavior: string; updatedInput?: unknown };
    expect(decision.behavior).toBe("allow");
    expect(decision.updatedInput).toEqual(input);
    expect(relay.getLog()).toHaveLength(2);
  });

  it("answers a pending question through answer() when nothing is armed", async () => {
    relay.setAutoAnswer(null);
    const seen: number[] = [];
    relay.onRequest = (entry: { id: number }) => seen.push(entry.id);

    const replyPromise = mcp.request("tools/call", {
      name: "approve",
      arguments: { tool_name: "Write", input: { file_path: "x" }, tool_use_id: "tu_3" },
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(seen).toHaveLength(1);
    expect(relay.answer(seen[0], { behavior: "allow" })).toBe(true);

    const decision = decisionOf(await replyPromise);
    expect(decision.behavior).toBe("allow");
  });

  it("denies an unknown tool without asking the relay", async () => {
    const before = relay.getLog().length;
    const reply = await mcp.request("tools/call", {
      name: "not-approve",
      arguments: {},
    });
    expect(decisionOf(reply).behavior).toBe("deny");
    expect(relay.getLog()).toHaveLength(before);
  });

  it("denies on a wrong token", async () => {
    const rogue = startMcp({
      PT_PERMISSION_RELAY_PORT: String(port),
      PT_PERMISSION_RELAY_TOKEN: "not-the-token",
    });
    try {
      await rogue.request("initialize", { protocolVersion: "2024-11-05" });
      relay.setAutoAnswer("allow"); // even armed allow must not leak to a bad token
      const reply = await rogue.request("tools/call", {
        name: "approve",
        arguments: { tool_name: "Bash", input: {}, tool_use_id: "tu_4" },
      });
      expect(decisionOf(reply).behavior).toBe("deny");
    } finally {
      relay.setAutoAnswer(null);
      rogue.child.kill();
    }
  });
});
