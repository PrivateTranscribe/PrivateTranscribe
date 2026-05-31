import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

describe("renderer CSP", () => {
  it("ships a CSP before remote resources are loaded", () => {
    const html = fs.readFileSync(path.join(process.cwd(), "src", "index.html"), "utf8");
    const cspIndex = html.indexOf('http-equiv="Content-Security-Policy"');
    const fontIndex = html.indexOf("https://api.fontshare.com");

    expect(cspIndex).toBeGreaterThan(-1);
    expect(cspIndex).toBeLessThan(fontIndex);
    expect(html).toContain("script-src 'self'");
    expect(html).toContain("object-src 'none'");
    expect(html).not.toContain("script-src 'self' 'unsafe-inline'");
    expect(html).not.toContain("script-src 'self' 'unsafe-eval'");
  });
});
