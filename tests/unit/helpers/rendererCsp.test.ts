import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

const html = () => fs.readFileSync(path.join(process.cwd(), "src", "index.html"), "utf8");

describe("renderer CSP", () => {
  it("ships a CSP inside the first tags of the head", () => {
    const source = html();
    const cspIndex = source.indexOf('http-equiv="Content-Security-Policy"');
    const titleIndex = source.indexOf("<title>");

    expect(cspIndex).toBeGreaterThan(-1);
    // A CSP declared after the resources it governs is decorative, so keep it
    // ahead of everything the document pulls in.
    expect(cspIndex).toBeLessThan(titleIndex);
    expect(source).toContain("script-src 'self'");
    expect(source).toContain("object-src 'none'");
    expect(source).not.toContain("script-src 'self' 'unsafe-inline'");
    expect(source).not.toContain("script-src 'self' 'unsafe-eval'");
  });

  it("loads no styles or fonts from off the machine", () => {
    const source = html();

    // These two used to be render-blocking <link> tags. They kept the window
    // white until two public servers answered, and they made a launch of a
    // local-only product a request to Google. Both faces are bundled now.
    expect(source).not.toContain("api.fontshare.com");
    expect(source).not.toContain("fonts.googleapis.com");
    expect(source).not.toContain("fonts.gstatic.com");
    expect(source).not.toMatch(/<link[^>]+href="https?:\/\//);

    // And the policy has to forbid them, so a reintroduced remote face fails
    // loudly rather than quietly costing a launch a network round trip.
    expect(source).toContain("style-src 'self' 'unsafe-inline';");
    expect(source).toContain("font-src 'self' data:;");
  });
});
