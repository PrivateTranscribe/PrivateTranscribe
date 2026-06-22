/**
 * Tests for URL security utilities
 * @module tests/unit/utils/urlUtils
 */

import { describe, it, expect } from "vitest";
import { isSecureEndpoint } from "../../../src/utils/urlUtils";

const isPrivateHttpHost = (hostname: string): boolean => {
  const host = hostname.includes(":") && !hostname.startsWith("[") ? `[${hostname}]` : hostname;
  return isSecureEndpoint(`http://${host}`);
};

describe("urlUtils", () => {
  describe("isPrivateHost", () => {
    describe("localhost detection", () => {
      it("identifies localhost as private", () => {
        expect(isPrivateHttpHost("localhost")).toBe(true);
      });

      it("identifies 0.0.0.0 as private", () => {
        expect(isPrivateHttpHost("0.0.0.0")).toBe(true);
      });

      it("identifies 127.x.x.x loopback addresses as private", () => {
        expect(isPrivateHttpHost("127.0.0.1")).toBe(true);
        expect(isPrivateHttpHost("127.0.0.2")).toBe(true);
        expect(isPrivateHttpHost("127.255.255.255")).toBe(true);
      });

      it("identifies IPv6 loopback as private", () => {
        expect(isPrivateHttpHost("::1")).toBe(true);
      });
    });

    describe("private IPv4 ranges", () => {
      it("identifies 10.x.x.x (Class A) as private", () => {
        expect(isPrivateHttpHost("10.0.0.1")).toBe(true);
        expect(isPrivateHttpHost("10.255.255.255")).toBe(true);
        expect(isPrivateHttpHost("10.0.0.0")).toBe(true);
      });

      it("identifies 192.168.x.x (Class C) as private", () => {
        expect(isPrivateHttpHost("192.168.0.1")).toBe(true);
        expect(isPrivateHttpHost("192.168.1.1")).toBe(true);
        expect(isPrivateHttpHost("192.168.255.255")).toBe(true);
      });

      it("identifies 172.16-31.x.x (Class B) as private", () => {
        expect(isPrivateHttpHost("172.16.0.1")).toBe(true);
        expect(isPrivateHttpHost("172.20.0.1")).toBe(true);
        expect(isPrivateHttpHost("172.31.255.255")).toBe(true);
      });

      it("does NOT identify 172.32+ as private", () => {
        expect(isPrivateHttpHost("172.32.0.1")).toBe(false);
        expect(isPrivateHttpHost("172.15.0.1")).toBe(false);
        expect(isPrivateHttpHost("172.0.0.1")).toBe(false);
      });

      it("identifies link-local addresses (169.254.x.x) as private", () => {
        expect(isPrivateHttpHost("169.254.0.1")).toBe(true);
        expect(isPrivateHttpHost("169.254.255.254")).toBe(true);
      });
    });

    describe("private IPv6 ranges", () => {
      it("identifies link-local IPv6 (fe80::) as private", () => {
        expect(isPrivateHttpHost("fe80::1")).toBe(true);
        expect(isPrivateHttpHost("fe80:0:0:0:0:0:0:1")).toBe(true);
      });

      it("identifies unique local addresses (fc00::/fd00::) as private", () => {
        expect(isPrivateHttpHost("fc00::1")).toBe(true);
        expect(isPrivateHttpHost("fd00::1")).toBe(true);
        expect(isPrivateHttpHost("fd12:3456:789a::1")).toBe(true);
      });

      it("handles bracketed IPv6 addresses", () => {
        expect(isPrivateHttpHost("[::1]")).toBe(true);
        expect(isPrivateHttpHost("[fe80::1]")).toBe(true);
      });
    });

    describe(".local domain", () => {
      it("identifies .local domains as private", () => {
        expect(isPrivateHttpHost("mycomputer.local")).toBe(true);
        expect(isPrivateHttpHost("server.local")).toBe(true);
        expect(isPrivateHttpHost("test.local")).toBe(true);
      });
    });

    describe("public hosts", () => {
      it("identifies public IP addresses as NOT private", () => {
        expect(isPrivateHttpHost("8.8.8.8")).toBe(false);
        expect(isPrivateHttpHost("1.1.1.1")).toBe(false);
        expect(isPrivateHttpHost("142.250.80.46")).toBe(false);
      });

      it("identifies public domains as NOT private", () => {
        expect(isPrivateHttpHost("api.openai.com")).toBe(false);
        expect(isPrivateHttpHost("google.com")).toBe(false);
        expect(isPrivateHttpHost("example.com")).toBe(false);
      });
    });

    describe("case insensitivity", () => {
      it("handles uppercase hostnames", () => {
        expect(isPrivateHttpHost("LOCALHOST")).toBe(true);
        expect(isPrivateHttpHost("MyServer.LOCAL")).toBe(true);
      });
    });
  });

  describe("isSecureEndpoint", () => {
    describe("HTTPS URLs", () => {
      it("allows HTTPS URLs to public hosts", () => {
        expect(isSecureEndpoint("https://api.openai.com/v1")).toBe(true);
        expect(isSecureEndpoint("https://api.anthropic.com")).toBe(true);
        expect(isSecureEndpoint("https://example.com:8443")).toBe(true);
      });

      it("allows HTTPS URLs to private hosts", () => {
        expect(isSecureEndpoint("https://localhost:3000")).toBe(true);
        expect(isSecureEndpoint("https://192.168.1.1")).toBe(true);
      });
    });

    describe("HTTP URLs", () => {
      it("allows HTTP URLs to localhost", () => {
        expect(isSecureEndpoint("http://localhost:8080")).toBe(true);
        expect(isSecureEndpoint("http://localhost")).toBe(true);
      });

      it("allows HTTP URLs to private networks", () => {
        expect(isSecureEndpoint("http://192.168.1.100:3000")).toBe(true);
        expect(isSecureEndpoint("http://10.0.0.5:8080")).toBe(true);
        expect(isSecureEndpoint("http://127.0.0.1:11434")).toBe(true);
      });

      it("allows HTTP URLs to .local domains", () => {
        expect(isSecureEndpoint("http://myserver.local:8080")).toBe(true);
      });

      it("rejects HTTP URLs to public hosts", () => {
        expect(isSecureEndpoint("http://api.openai.com")).toBe(false);
        expect(isSecureEndpoint("http://example.com")).toBe(false);
        expect(isSecureEndpoint("http://8.8.8.8")).toBe(false);
      });
    });

    describe("invalid URLs", () => {
      it("returns false for invalid URLs", () => {
        expect(isSecureEndpoint("not-a-url")).toBe(false);
        expect(isSecureEndpoint("")).toBe(false);
        expect(isSecureEndpoint("ftp://example.com")).toBe(false);
      });

      it("returns false for malformed URLs", () => {
        expect(isSecureEndpoint("http://")).toBe(false);
        expect(isSecureEndpoint("://missing-protocol")).toBe(false);
      });
    });

    describe("edge cases", () => {
      it("handles URLs with paths and query strings", () => {
        expect(isSecureEndpoint("https://api.example.com/v1/chat?key=test")).toBe(true);
        expect(isSecureEndpoint("http://localhost:3000/api/transcribe")).toBe(true);
      });

      it("handles URLs with authentication", () => {
        expect(isSecureEndpoint("https://user:pass@api.example.com")).toBe(true);
        expect(isSecureEndpoint("http://user:pass@localhost:3000")).toBe(true);
      });
    });
  });
});
