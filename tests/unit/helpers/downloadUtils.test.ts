/**
 * Tests for downloadUtils helpers
 * @module tests/unit/helpers/downloadUtils
 *
 * Strategy:
 *  - Pure helper functions (isRetryable, backoffDelay) are inlined and tested directly.
 *  - Integration tests spin up a real local HTTP server and use a temp directory
 *    to verify file-system behavior (partial preservation, resume, atomic rename).
 *    debugLogger is mocked so we don't pull in the Electron dependency.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as http from "http";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// ── Mock Electron-dependent logger ────────────────────────────────────────────
vi.mock("../../../src/helpers/debugLogger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
  info: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  error: vi.fn(),
}));

// ── Inline pure helpers (mirroring downloadUtils.js internals) ────────────────

const RETRYABLE_CODES = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "EPIPE",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ENOTFOUND",
  "ERR_STREAM_PREMATURE_CLOSE",
]);

function isRetryable(error: { isAbort?: boolean; isHttpError?: boolean; code?: string }) {
  if (error.isAbort || error.isHttpError) return false;
  return RETRYABLE_CODES.has(error.code ?? "");
}

const MAX_BACKOFF_MS = 30000;
function backoffDelay(attempt: number) {
  return Math.min(1000 * Math.pow(2, attempt), MAX_BACKOFF_MS);
}

// ── Unit tests for pure helpers ───────────────────────────────────────────────

describe("isRetryable", () => {
  it("is false for abort errors", () => {
    expect(isRetryable({ isAbort: true, code: "ECONNRESET" })).toBe(false);
  });

  it("is false for HTTP errors", () => {
    expect(isRetryable({ isHttpError: true, code: "ECONNRESET" })).toBe(false);
  });

  it("is true for all retryable network codes", () => {
    for (const code of RETRYABLE_CODES) {
      expect(isRetryable({ code })).toBe(true);
    }
  });

  it("is false for unknown error codes", () => {
    expect(isRetryable({ code: "ENOENT" })).toBe(false);
    expect(isRetryable({ code: "EACCES" })).toBe(false);
    expect(isRetryable({})).toBe(false);
  });
});

describe("backoffDelay", () => {
  it("starts at 1 s on attempt 0", () => {
    expect(backoffDelay(0)).toBe(1000);
  });

  it("doubles each attempt", () => {
    expect(backoffDelay(1)).toBe(2000);
    expect(backoffDelay(2)).toBe(4000);
    expect(backoffDelay(3)).toBe(8000);
  });

  it("caps at MAX_BACKOFF_MS", () => {
    expect(backoffDelay(10)).toBe(MAX_BACKOFF_MS);
    expect(backoffDelay(100)).toBe(MAX_BACKOFF_MS);
  });
});

// ── Integration tests (real HTTP server + real fs in a temp dir) ──────────────

describe("downloadFile integration", () => {
  let server: http.Server;
  let tmpDir: string;

  // We reload the module fresh in each test so vi.mock takes effect
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let downloadFile: (...args: any[]) => Promise<string>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let createDownloadSignal: () => { signal: any; abort: () => void };

  beforeEach(() => {
    vi.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("../../../src/helpers/downloadUtils");
    downloadFile = mod.downloadFile;
    createDownloadSignal = mod.createDownloadSignal;

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-dl-test-"));
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Start a local HTTP server; returns the assigned port. */
  function startServer(
    handler: (req: http.IncomingMessage, res: http.ServerResponse) => void
  ): Promise<number> {
    server = http.createServer(handler);
    return new Promise((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address() as { port: number };
        resolve(addr.port);
      });
    });
  }

  it("downloads a complete file and atomically renames .tmp → dest", async () => {
    const content = "hello world";
    const port = await startServer((_req, res) => {
      res.writeHead(200, { "content-length": String(content.length) });
      res.end(content);
    });

    const destPath = path.join(tmpDir, "model.bin");
    await downloadFile(`http://127.0.0.1:${port}/file`, destPath);

    expect(fs.readFileSync(destPath, "utf8")).toBe(content);
    expect(fs.existsSync(destPath + ".tmp")).toBe(false);
  });

  it("preserves .tmp on user abort so the next attempt can resume", async () => {
    // Pre-seed a partial .tmp simulating a previous interrupted download.
    const content = Buffer.alloc(200, 0x61);

    // Server must be running so resolveRedirects (HEAD) succeeds.
    // We pre-abort the signal so the download loop throws isAbort immediately
    // without issuing the GET, cleanly testing just the file-handling path.
    const port = await startServer((_req, res) => {
      res.writeHead(200, { "content-length": String(content.length) });
      res.end(content);
    });

    const destPath = path.join(tmpDir, "model.bin");
    const tmpPath = destPath + ".tmp";
    fs.writeFileSync(tmpPath, content.slice(0, 100)); // partial progress

    const { signal, abort } = createDownloadSignal();
    abort(); // pre-abort so the download throws isAbort without writing

    await expect(
      downloadFile(`http://127.0.0.1:${port}/file`, destPath, { signal, maxRetries: 0 })
    ).rejects.toMatchObject({ isAbort: true });

    // Key assertion: partial file must still exist for resume
    expect(fs.existsSync(tmpPath)).toBe(true);
    expect(fs.statSync(tmpPath).size).toBe(100);
  });

  it("resumes from existing .tmp when server supports Range", async () => {
    const content = Buffer.alloc(200, 0x62); // 200 × 'b'
    const firstHalf = content.slice(0, 100);

    // Pre-seed the .tmp as if a previous download was interrupted
    const destPath = path.join(tmpDir, "model.bin");
    const tmpPath = destPath + ".tmp";
    fs.writeFileSync(tmpPath, firstHalf);

    const rangeRequests: string[] = [];

    const port = await startServer((req, res) => {
      const rangeHeader = req.headers["range"];
      if (rangeHeader) {
        rangeRequests.push(rangeHeader);
        const match = rangeHeader.match(/bytes=(\d+)-/);
        const offset = match ? parseInt(match[1], 10) : 0;
        const slice = content.slice(offset);
        res.writeHead(206, {
          "content-range": `bytes ${offset}-${content.length - 1}/${content.length}`,
          "content-length": String(slice.length),
        });
        res.end(slice);
      } else {
        res.writeHead(200, { "content-length": String(content.length) });
        res.end(content);
      }
    });

    await downloadFile(`http://127.0.0.1:${port}/file`, destPath);

    // A Range header should have been sent (resume, not fresh start)
    expect(rangeRequests.length).toBe(1);
    expect(rangeRequests[0]).toBe("bytes=100-");

    // Final file must be the full content
    expect(fs.readFileSync(destPath)).toEqual(content);
    expect(fs.existsSync(tmpPath)).toBe(false);
  });

  it("deletes .tmp when a non-retryable HTTP error occurs", async () => {
    const port = await startServer((_req, res) => {
      res.writeHead(404);
      res.end("Not Found");
    });

    const destPath = path.join(tmpDir, "model.bin");
    const tmpPath = destPath + ".tmp";

    await expect(
      downloadFile(`http://127.0.0.1:${port}/file`, destPath, { maxRetries: 0 })
    ).rejects.toMatchObject({ isHttpError: true });

    expect(fs.existsSync(tmpPath)).toBe(false);
  });
});
