import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import { isValidApiUrl } from "../../../src/helpers/urlValidation";

const read = (...parts: string[]) => fs.readFileSync(path.join(process.cwd(), ...parts), "utf8");

describe("custom API address check", () => {
  it("accepts every local address the cleanup settings suggest", () => {
    const suggested = [
      ...read("src", "components", "ReasoningModelSelector.tsx").matchAll(
        /<code[^>]*>(https?:\/\/[^<]+)<\/code>/g
      ),
    ].map((match) => match[1]);

    expect(suggested).toEqual(["http://localhost:11434/v1", "http://localhost:8080/v1"]);
    for (const url of suggested) {
      expect(isValidApiUrl(url)).toEqual({ valid: true });
    }
  });

  it.each([
    "http://127.0.0.1:1234/v1",
    "http://[::1]:11434/v1",
    "https://localhost:8443/v1",
    "https://192.168.1.20/v1",
    "https://[fd00::5]/v1",
    "https://[2606:4700::1111]/v1",
    "https://gpu-box.local/v1",
    "https://api.openai.com/v1",
    "",
  ])("accepts %s", (url) => {
    expect(isValidApiUrl(url).valid).toBe(true);
  });

  // Plain http leaves this PC unencrypted, and the renderer's content security
  // policy blocks it, so saving one would only look like it worked.
  it.each([
    ["http://192.168.1.20:11434/v1", "https://"],
    ["http://gpu-box.local:11434/v1", "https://"],
    ["http://api.example.com/v1", "https://"],
    ["http://0.0.0.0:8080/v1", "localhost or 127.0.0.1"],
    ["http://169.254.169.254/latest", "Link-local"],
    ["https://169.254.169.254/latest", "Link-local"],
    // IPv6 forms of the same addresses.
    ["https://[fe80::1]/v1", "Link-local"],
    ["https://[::ffff:169.254.169.254]/latest", "Link-local"],
    ["https://[::]/v1", "localhost or 127.0.0.1"],
    ["https://[::ffff:0.0.0.0]/v1", "localhost or 127.0.0.1"],
    ["https://myserver/v1", "full domain name"],
    ["file:///C:/models", "http:// and https://"],
    ["localhost:11434/v1", "http:// and https://"],
    ["not a url", "full address"],
  ])("refuses %s and says why", (url, reason) => {
    const result = isValidApiUrl(url);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain(reason);
  });

  it("accepts plain http only for hosts the renderer's policy lets it reach", () => {
    const connectSrc = read("src", "index.html").match(/connect-src ([^;]+);/)?.[1] ?? "";
    for (const url of ["http://localhost:11434/v1", "http://127.0.0.1:1234", "http://[::1]:8080"]) {
      expect(isValidApiUrl(url).valid).toBe(true);
      expect(connectSrc.split(" ")).toContain(`http://${new URL(url).hostname}:*`);
    }
  });
});
