import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createPackage } from "@electron/asar";
import { describe, expect, test } from "vitest";

const repoRoot = resolve(__dirname, "../../..");
const read = (relativePath: string) => readFileSync(resolve(repoRoot, relativePath), "utf8");

const FLAG = "privatetranscribeOfficialBuild";
// Long form only: `-c.extraMetadata...` is read as a config file path and the
// build dies with ENOENT.
const OFFICIAL_BUILD_ARG = `--config.extraMetadata.${FLAG}=true`;

/** The `run:` line that invokes a build script, so the flag has to reach that build. */
const buildCommand = (workflow: string, script: string) =>
  read(workflow)
    .split("\n")
    .find((line) => line.trimStart().startsWith("run:") && line.includes(script));

const withoutComments = (yaml: string) =>
  yaml
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");

/**
 * Only builds that reach users may check for app updates and send analytics.
 * The flag rides on electron-builder's extraMetadata into the packaged
 * package.json, so it belongs on the build command of exactly the workflows
 * that ship, and nowhere a copy built from source would pick it up.
 */
describe("official build flag", () => {
  test.each([
    // The installer on the website and the update feed.
    { workflow: ".github/workflows/release.yml", script: "npm run build:win" },
    // The Microsoft Store installer.
    { workflow: ".github/workflows/build-store.yml", script: "npm run build:store" },
  ])("$workflow marks its build official", ({ workflow, script }) => {
    expect(buildCommand(workflow, script)).toContain(OFFICIAL_BUILD_ARG);
  });

  test.each([
    { workflow: ".github/workflows/release.yml", outputDir: "dist" },
    { workflow: ".github/workflows/build-store.yml", outputDir: "dist-store" },
  ])("$workflow checks the packaged app for the flag", ({ workflow, outputDir }) => {
    expect(read(workflow)).toContain(
      `node scripts/verify-official-build.js ${outputDir}/win-unpacked/resources/app.asar`
    );
  });

  test("the test installer stays unofficial", () => {
    // It never reaches users, so an installed test copy must not phone home.
    expect(withoutComments(read(".github/workflows/build-windows.yml"))).not.toContain(FLAG);
  });

  test("building from source never sets it", () => {
    // npm run dev, pack, build, dist and build:store all read these two files.
    expect(read("package.json")).not.toContain(FLAG);
    expect(read("electron-builder.json")).not.toContain(FLAG);
  });
});

describe("verify-official-build.js", () => {
  /** Packs a package.json into app.asar the way electron-builder ships it, then checks it. */
  async function verifyPackagedApp(fields: Record<string, unknown>) {
    const dir = mkdtempSync(join(tmpdir(), "pt-official-asar-"));
    try {
      const appDir = join(dir, "app");
      mkdirSync(appDir);
      writeFileSync(join(appDir, "package.json"), JSON.stringify({ name: "x", ...fields }));
      const asarPath = join(dir, "app.asar");
      await createPackage(appDir, asarPath);
      return spawnSync(
        process.execPath,
        [resolve(repoRoot, "scripts/verify-official-build.js"), asarPath],
        { encoding: "utf8" }
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("passes a packaged app that carries the flag", async () => {
    expect((await verifyPackagedApp({ [FLAG]: true })).status).toBe(0);
  });

  test("fails a packaged app without it, naming the flag", async () => {
    const result = await verifyPackagedApp({});
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(FLAG);
  });
});
