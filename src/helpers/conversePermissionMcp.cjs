#!/usr/bin/env node
/**
 * Stdio MCP server the `claude` CLI spawns to ask Converse's user about
 * permissions (`--permission-prompt-tool mcp__pt-permissions__approve`).
 *
 * Deliberately dependency-free and Electron-free: the CLI launches this with a
 * bare node, so it cannot require anything from the app. It speaks
 * newline-delimited JSON-RPC 2.0 (MCP stdio framing) and exposes exactly one
 * tool. Every question is forwarded to the app's loopback relay
 * (conversePermissionRelay.js) and the relay's decision is returned verbatim.
 *
 * FAIL CLOSED: if the relay is unreachable, times out, or returns anything
 * unexpected, this answers deny. A lost connection must never grant anything.
 */

const http = require("node:http");
const readline = require("node:readline");

const PORT = Number(process.env.PT_PERMISSION_RELAY_PORT || 0);
const TOKEN = process.env.PT_PERMISSION_RELAY_TOKEN || "";

const TOOL_NAME = "approve";

function write(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function askRelay(payload) {
  return new Promise((resolve) => {
    const deny = (why) => resolve({ behavior: "deny", message: why });
    if (!PORT || !TOKEN) {
      deny("permission relay is not configured");
      return;
    }
    const body = JSON.stringify({ token: TOKEN, ...payload });
    const req = http.request(
      {
        host: "127.0.0.1",
        port: PORT,
        path: "/permission",
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
        // The relay holds the question open while the user decides; its own
        // 55s deny-timeout fires first, so this is just a safety margin.
        timeout: 70_000,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            const parsed = JSON.parse(data);
            if (parsed && (parsed.behavior === "allow" || parsed.behavior === "deny")) {
              resolve(parsed);
              return;
            }
          } catch {
            // fall through to deny
          }
          deny("permission relay returned an unreadable answer");
        });
      }
    );
    req.on("timeout", () => {
      req.destroy();
      deny("permission relay timed out");
    });
    req.on("error", () => deny("permission relay is unreachable"));
    req.end(body);
  });
}

async function handle(msg) {
  const { id, method, params } = msg;
  const reply = (result) => write({ jsonrpc: "2.0", id, result });

  if (method === "initialize") {
    reply({
      protocolVersion: params?.protocolVersion || "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "pt-permissions", version: "1.0.0" },
    });
    return;
  }
  if (method === "notifications/initialized" || String(method || "").startsWith("notifications/")) {
    return; // notifications get no response
  }
  if (method === "tools/list") {
    reply({
      tools: [
        {
          name: TOOL_NAME,
          description:
            "Relays the pending permission question to the PrivateTranscribe user and returns their decision.",
          inputSchema: {
            type: "object",
            properties: {
              tool_name: { type: "string" },
              input: { type: "object" },
              tool_use_id: { type: "string" },
            },
          },
        },
      ],
    });
    return;
  }
  if (method === "tools/call") {
    const args = params?.arguments || {};
    const decision =
      params?.name === TOOL_NAME
        ? await askRelay({
            tool_name: args.tool_name,
            input: args.input,
            tool_use_id: args.tool_use_id,
          })
        : { behavior: "deny", message: `unknown tool: ${params?.name}` };

    const payload =
      decision.behavior === "allow"
        ? { behavior: "allow", updatedInput: args.input ?? {} }
        : { behavior: "deny", message: decision.message || "denied" };

    reply({ content: [{ type: "text", text: JSON.stringify(payload) }] });
    return;
  }
  if (id !== undefined) {
    write({ jsonrpc: "2.0", id, error: { code: -32601, message: `unknown method: ${method}` } });
  }
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg = null;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return; // not JSON-RPC; ignore rather than crash the channel
  }
  handle(msg).catch(() => {
    if (msg && msg.id !== undefined) {
      write({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          content: [
            { type: "text", text: JSON.stringify({ behavior: "deny", message: "relay error" }) },
          ],
        },
      });
    }
  });
});
rl.on("close", () => process.exit(0));
