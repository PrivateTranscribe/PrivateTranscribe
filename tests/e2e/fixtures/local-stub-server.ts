import http from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A stand-in for a local engine or a custom endpoint, listening on 127.0.0.1.
 *
 * It lets a spec decide what the app is answered, how fast and in how many
 * pieces, and read back exactly what the app sent. A handler that awaits before
 * it replies keeps the request in flight for that long. Nothing leaves the machine,
 * and no provider is ever called.
 */

export type StubRequest = {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
  /** True once the app dropped the connection before the answer was complete. */
  aborted: boolean;
};

export type StubReply = {
  json: (value: unknown, status?: number) => void;
  /**
   * Send a JSON answer cut inside every letter that takes more than one byte,
   * each piece in a network write of its own.
   */
  jsonInPieces: (value: unknown) => Promise<void>;
};

export type StubServer = {
  port: number;
  url: string;
  requests: StubRequest[];
  close: () => Promise<void>;
};

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A page of the app may read the answer: it calls custom endpoints itself. */
const ANSWER_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Allow-Methods": "*",
};

/** The value of one text field in a multipart form the app posted. */
export function formField(request: StubRequest, name: string): string | null {
  const body = request.body.toString("utf8");
  const start = body.indexOf(`name="${name}"`);
  if (start < 0) return null;
  const valueAt = body.indexOf("\r\n\r\n", start);
  const end = body.indexOf("\r\n--", valueAt);
  return valueAt < 0 || end < 0 ? null : body.slice(valueAt + 4, end);
}

/** Cut a UTF-8 buffer so that no multi-byte letter arrives whole. */
function cutInsideLetters(bytes: Buffer): Buffer[] {
  const pieces: Buffer[] = [];
  let start = 0;
  for (let i = 1; i < bytes.length; i++) {
    const isContinuationByte = (bytes[i] & 0b1100_0000) === 0b1000_0000;
    if (isContinuationByte) {
      pieces.push(bytes.subarray(start, i));
      start = i;
    }
  }
  pieces.push(bytes.subarray(start));
  return pieces.filter((piece) => piece.length > 0);
}

export async function startStubServer(
  handler: (request: StubRequest, reply: StubReply) => void | Promise<void>
): Promise<StubServer> {
  const requests: StubRequest[] = [];

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    const record: StubRequest = {
      method: req.method ?? "",
      url: req.url ?? "",
      headers: req.headers,
      body: Buffer.alloc(0),
      aborted: false,
    };
    requests.push(record);
    res.on("close", () => {
      if (!res.writableEnded) record.aborted = true;
    });

    const reply: StubReply = {
      json(value, status = 200) {
        if (res.destroyed) return;
        res.writeHead(status, ANSWER_HEADERS);
        res.end(JSON.stringify(value));
      },
      async jsonInPieces(value) {
        const pieces = cutInsideLetters(Buffer.from(JSON.stringify(value), "utf8"));
        res.socket?.setNoDelay(true);
        res.writeHead(200, ANSWER_HEADERS);
        for (const piece of pieces) {
          if (res.destroyed) return;
          res.write(piece);
          // Long enough for the piece to reach the app as a read of its own.
          await pause(15);
        }
        res.end();
      },
    };

    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      record.body = Buffer.concat(chunks);
      Promise.resolve(handler(record, reply)).catch(() => {
        if (!res.headersSent && !res.destroyed) res.writeHead(500);
        if (!res.destroyed) res.end();
      });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    port,
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
