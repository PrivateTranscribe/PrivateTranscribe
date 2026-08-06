/**
 * Tests for download transport enforcement.
 * @module tests/unit/helpers/downloadUrlSecurity
 *
 * Downloaded artifacts are executed as native code (whisper-server,
 * llama-server, sherpa-onnx, key listeners). They must not be fetchable over a
 * channel an attacker can rewrite, including via an https -> http redirect.
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("../../../src/helpers/debugLogger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(), log: vi.fn() },
}));

async function loadAssert() {
  const mod = await import("../../../src/helpers/downloadUtils.js");
  return mod.assertSecureDownloadUrl as (url: string) => unknown;
}

describe("assertSecureDownloadUrl", () => {
  it("accepts the HTTPS release and model hosts we actually use", async () => {
    const assertSecureDownloadUrl = await loadAssert();
    expect(() =>
      assertSecureDownloadUrl("https://github.com/ggerganov/whisper.cpp/releases/x.zip")
    ).not.toThrow();
    expect(() =>
      assertSecureDownloadUrl("https://huggingface.co/repo/resolve/main/model.bin")
    ).not.toThrow();
  });

  it("rejects cleartext HTTP from a remote host", async () => {
    const assertSecureDownloadUrl = await loadAssert();
    expect(() => assertSecureDownloadUrl("http://evil.example/whisper-server.exe")).toThrow(
      /HTTPS required/
    );
  });

  it("marks the rejection fatal so the retry loop does not spin on it", async () => {
    const assertSecureDownloadUrl = await loadAssert();
    let caught: { isHttpError?: boolean } | null = null;
    try {
      assertSecureDownloadUrl("http://evil.example/x.bin");
    } catch (err) {
      caught = err as { isHttpError?: boolean };
    }
    expect(caught?.isHttpError).toBe(true);
  });

  it("still allows loopback HTTP for local servers and test fixtures", async () => {
    const assertSecureDownloadUrl = await loadAssert();
    expect(() => assertSecureDownloadUrl("http://127.0.0.1:8080/file")).not.toThrow();
    expect(() => assertSecureDownloadUrl("http://localhost:5174/file")).not.toThrow();
    expect(() => assertSecureDownloadUrl("http://[::1]:9000/file")).not.toThrow();
  });

  it("does not treat a look-alike remote host as loopback", async () => {
    const assertSecureDownloadUrl = await loadAssert();
    expect(() => assertSecureDownloadUrl("http://127.0.0.1.evil.example/x.bin")).toThrow(
      /HTTPS required/
    );
    expect(() => assertSecureDownloadUrl("http://localhost.evil.example/x.bin")).toThrow(
      /HTTPS required/
    );
  });

  it("rejects non-HTTP protocols outright", async () => {
    const assertSecureDownloadUrl = await loadAssert();
    expect(() => assertSecureDownloadUrl("file:///etc/passwd")).toThrow(/HTTPS required/);
    expect(() => assertSecureDownloadUrl("ftp://example.com/x.bin")).toThrow(/HTTPS required/);
  });

  it("rejects malformed URLs", async () => {
    const assertSecureDownloadUrl = await loadAssert();
    expect(() => assertSecureDownloadUrl("not a url")).toThrow(/Invalid download URL/);
  });
});
