import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";

/**
 * A response from the local Whisper or AI cleanup server can arrive in more
 * than one read. Each read was turned into text on its own, so a letter such
 * as "ø" whose two bytes landed in different reads came out as two "�".
 */

const WhisperServerManager = require("../../../src/helpers/whisperServer");
const LlamaServerManager = require("../../../src/helpers/llamaServer");

const servers: http.Server[] = [];

/** Answers every request with `body`, cut in the middle of its first "ø". */
async function serverThatSplitsALetter(body: string) {
  const bytes = Buffer.from(body, "utf8");
  const cut = bytes.indexOf(Buffer.from("ø", "utf8")) + 1;
  if (cut <= 0) throw new Error("The body needs an ø to split");

  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.socket?.setNoDelay(true);
      res.writeHead(200, { "Content-Type": "application/json", "Content-Length": bytes.length });
      res.write(bytes.subarray(0, cut));
      setTimeout(() => res.end(bytes.subarray(cut)), 50);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Failed to start test server");
  return address.port;
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

describe("a local server response that arrives in two reads", () => {
  it("keeps a Danish letter whole in a Whisper transcript", async () => {
    const manager: any = new WhisperServerManager();
    manager.port = await serverThatSplitsALetter(JSON.stringify({ text: "Rødgrød med fløde" }));
    manager.requestPathPrefix = "/pt-unit-test";
    manager.ready = true;

    const result = await manager._postInference(Buffer.from("not really a wav"), {
      durationSeconds: 1,
    });

    expect(result.text).toBe("Rødgrød med fløde");
  });

  it("keeps a Danish letter whole in text cleaned up by the local AI model", async () => {
    const manager: any = new LlamaServerManager();
    manager.port = await serverThatSplitsALetter(
      JSON.stringify({
        choices: [{ message: { content: "Rødgrød med fløde." }, finish_reason: "stop" }],
      })
    );
    manager.apiKey = "unit-test-key";
    manager.process = {};
    manager.ready = true;
    manager.idleTimeoutMs = 0;

    const text = await manager.inference([{ role: "user", content: "rødgrød med fløde" }]);

    expect(text).toBe("Rødgrød med fløde.");
  });
});
