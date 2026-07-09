const fs = require("fs");
const path = require("path");

const repoRoot = path.resolve(__dirname, "../../..");

function readRepoFile(...segments) {
  return fs.readFileSync(path.join(repoRoot, ...segments), "utf8");
}

describe("Windows update signing configuration", () => {
  it("configures electron-updater to require the expected Windows publisher", () => {
    const builderConfig = JSON.parse(readRepoFile("electron-builder.json"));

    expect(builderConfig.win.signAndEditExecutable).toBe(true);
    expect(builderConfig.win.verifyUpdateCodeSignature).toBe(true);
    expect(builderConfig.win.publisherName).toContain("HeroTools Inc.");
  });

  it("requires signed production Windows artifacts before uploading the update feed", () => {
    const workflow = readRepoFile(".github", "workflows", "release-production.yml");

    expect(workflow).toContain("WIN_CSC_LINK");
    expect(workflow).toContain("WIN_CSC_KEY_PASSWORD");
    expect(workflow).toContain("-c.forceCodeSigning=true");
    expect(workflow).toContain("Get-AuthenticodeSignature");
    expect(workflow).toContain("EXPECTED_PUBLISHER: HeroTools Inc.");

    const signatureCheck = workflow.indexOf("Verify Windows signatures");
    const uploadStep = workflow.indexOf("Upload artifacts to R2");
    expect(signatureCheck).toBeGreaterThan(-1);
    expect(uploadStep).toBeGreaterThan(signatureCheck);
  });

  it("requires signed tag/manual Windows artifacts before publishing workflow artifacts", () => {
    const workflow = readRepoFile(".github", "workflows", "build-windows.yml");

    expect(workflow).toContain("WIN_CSC_LINK");
    expect(workflow).toContain("WIN_CSC_KEY_PASSWORD");
    expect(workflow).toContain("-c.forceCodeSigning=true");
    expect(workflow).toContain("Get-AuthenticodeSignature");
    expect(workflow).toContain("EXPECTED_PUBLISHER: HeroTools Inc.");

    const signatureCheck = workflow.indexOf("Verify Windows signatures");
    const uploadStep = workflow.indexOf("Upload NSIS installer");
    expect(signatureCheck).toBeGreaterThan(-1);
    expect(uploadStep).toBeGreaterThan(signatureCheck);
  });
});
