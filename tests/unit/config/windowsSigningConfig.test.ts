import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(__dirname, "../../..");

const builderConfig = JSON.parse(
  readFileSync(resolve(repoRoot, "electron-builder.json"), "utf8")
) as {
  win: {
    signAndEditExecutable: boolean;
    verifyUpdateCodeSignature: boolean;
    azureSignOptions: Record<string, string>;
  };
};

const workflows = [
  ".github/workflows/build-windows.yml",
  ".github/workflows/release-production.yml",
];

/**
 * Windows releases are signed by Azure Artifact Signing. None of this is
 * exercised by a normal test run — it only shows up in a release build — so
 * these assertions stand in for that, pinning the details that are easy to
 * break silently and expensive to notice late.
 */
describe("Windows signing configuration", () => {
  test("signs as the validated legal entity", () => {
    // The certificate subject is CN=Julsgaard Products. Anything else here and
    // the workflow's publisher check fails the build. The old reverted signing
    // commit had "HeroTools Inc." left over from the upstream project.
    expect(builderConfig.win.azureSignOptions.publisherName).toBe("Julsgaard Products");
  });

  test("points at the account the certificate profile actually lives in", () => {
    const azure = builderConfig.win.azureSignOptions;
    // North Europe, because West Europe rejects new customers with
    // RequestDisallowedByAzure. The endpoint is region-specific.
    expect(azure.endpoint).toBe("https://neu.codesigning.azure.net/");
    expect(azure.codeSigningAccountName).toBe("PrivateTranscribe");
    expect(azure.certificateProfileName).toBe("PrivateTranscribe");
  });

  test("requests a timestamp", () => {
    // Artifact Signing certificates live only a few days and rotate, so an
    // untimestamped signature stops verifying almost immediately after release.
    // electron-builder has shipped Azure-signed binaries with no timestamp at
    // all (electron-builder#8626), which is why these are set explicitly rather
    // than left to the default.
    const azure = builderConfig.win.azureSignOptions;
    expect(azure.TimestampRfc3161).toBe("http://timestamp.acs.microsoft.com");
    expect(azure.TimestampDigest).toBe("SHA256");
  });

  test("leaves signing off by default so local packaging needs no credentials", () => {
    // `npm run pack` is the documented way to build for personal use. With this
    // true, it would reach Azure and fail for anyone without the service
    // principal. CI turns it on per-build instead.
    expect(builderConfig.win.signAndEditExecutable).toBe(false);
  });

  test("every workflow that packages Windows turns signing on and verifies it", () => {
    for (const workflow of workflows) {
      const contents = readFileSync(resolve(repoRoot, workflow), "utf8");

      // Long form only. `-c.win.signAndEditExecutable=true` is read as a config
      // file path and the build dies with ENOENT.
      expect(contents).toContain("--config.win.signAndEditExecutable=true");
      expect(contents).toContain("--config.forceCodeSigning=true");

      // The backstop: if the flag above is ever dropped, this fails the build
      // instead of quietly publishing an unsigned installer.
      expect(contents).toContain("Verify Windows signatures");
      expect(contents).toContain("TimeStamperCertificate");
    }
  });
});
