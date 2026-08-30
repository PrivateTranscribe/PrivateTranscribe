import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(__dirname, "../../..");

const read = (relativePath: string) => readFileSync(resolve(repoRoot, relativePath), "utf8");

const builderConfig = JSON.parse(read("electron-builder.json")) as {
  nsis: { include: string; oneClick: boolean; perMachine: boolean };
};

const packageJson = JSON.parse(read("package.json")) as {
  scripts: Record<string, string>;
};

const storeInclude = read("resources/nsis/store-installer.nsh");
const publicInclude = read("resources/nsis/cleanup-models.nsh");
const storeBuildScript = packageJson.scripts["build:store"];
const storeWorkflow = read(".github/workflows/build-store.yml");
const releaseWorkflow = read(".github/workflows/build-windows.yml");

/** Comment lines explain what a workflow deliberately does not do, so asserting
 *  an absence has to look at what actually runs. */
const withoutComments = (yaml: string) =>
  yaml
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");

/**
 * The Microsoft Store accepts a plain EXE installer (policy 10.2.9) but hosts
 * only a link to it: it downloads the binary from our own versioned URL and
 * runs it with no arguments. "Initiating the install must not display an
 * installation user interface (i.e., silent install is required)" — so the
 * Store build needs an installer that is silent by itself, while the installer
 * people download from the website keeps its wizard.
 *
 * None of this runs in a normal test, and a silent installer looks identical to
 * a wizard one until someone runs it, so these assertions stand in for that.
 */
describe("Microsoft Store installer variant", () => {
  test("the Store installer is silent without being asked", () => {
    // `SilentInstall silent` is the NSIS attribute that makes the installer
    // behave as though /S were passed. customHeader is electron-builder's hook
    // for reaching the top level of the generated script, which is the only
    // place a script attribute is legal.
    expect(storeInclude).toContain("!macro customHeader");
    expect(storeInclude).toContain("SilentInstall silent");
  });

  test("the public installer keeps its wizard", () => {
    // The website download is not a Store submission and should still ask where
    // to install. If this ever picks up a customHeader, check it isn't silencing
    // the installer everybody else downloads.
    expect(publicInclude).not.toContain("SilentInstall");
    expect(publicInclude).not.toContain("customHeader");
    expect(builderConfig.nsis.include).toBe("resources/nsis/cleanup-models.nsh");
  });

  test("both variants share one uninstall hook", () => {
    // Only one include file can be configured, so the Store file pulls in the
    // public one instead of restating it. A copy would drift on what uninstall
    // deletes, which is app data and multi-gigabyte model caches.
    expect(storeInclude).toContain('!include "cleanup-models.nsh"');
    expect(storeInclude).toContain('!addincludedir "${PROJECT_DIR}\\resources\\nsis"');
    expect(storeInclude).not.toContain("!macro customUnInstall");
    expect(publicInclude).toContain("!macro customUnInstall");
  });

  test("the Store build swaps in the silent include", () => {
    // Long form only. `-c.nsis.include=...` is read as a config file path and
    // the build dies with ENOENT.
    expect(storeBuildScript).toContain(
      "--config.nsis.include=resources/nsis/store-installer.nsh"
    );
  });

  test("the Store build cannot be mistaken for the public release", () => {
    // Separate output directory so a Store artifact never lands in dist/ next to
    // the installer the website serves, and no publish step so its latest.yml
    // can never become what existing installs auto-update to.
    expect(storeBuildScript).toContain("--config.directories.output=dist-store");
    expect(storeBuildScript).toContain("--publish never");
  });

  test("CI builds the Store installer through the same npm script", () => {
    // Not a second copy of the flags. If the workflow restated them, the silent
    // include could be dropped from one and not the other and nothing would say
    // so until certification failed.
    expect(storeWorkflow).toContain("npm run build:store");
  });

  test("CI bundles the same payload the public installer ships", () => {
    // Run #1 shipped 13 MB light with no ggml/llama DLLs at all, because it
    // copied build-windows.yml's shorter download list. The installer users
    // actually get comes from release-production.yml, whose prebuild:win runs
    // the full prepare:resources — that is what fetches llama-server.
    expect(storeWorkflow).toContain("npm run prepare:resources");
    expect(storeWorkflow).toContain("Verify the local AI runtime was bundled");
    expect(storeWorkflow).toContain("ggml-base.dll");
  });

  test("CI refuses to ship an installer it has not proved is silent", () => {
    // A wizard fails Store certification, and the difference is invisible in the
    // artifact list. NSIS records it in the firstheader as FH_FLAGS_SILENT = 2.
    expect(storeWorkflow).toContain("Verify the installer is silent");
    expect(storeWorkflow).toContain("FH_FLAGS_SILENT");
  });

  test("the Store workflow never touches the auto-update feed", () => {
    // The public release publishes latest.yml and a blockmap, which is what
    // existing installs follow. A Store artifact appearing there would push a
    // silent installer at everyone as an update.
    expect(withoutComments(storeWorkflow)).not.toContain("latest.yml");
    expect(withoutComments(storeWorkflow)).not.toContain("blockmap");
    expect(withoutComments(releaseWorkflow)).toContain("latest.yml");
  });

  test("the Store URL is versioned and write-once", () => {
    // Policy 10.2.9: the binary behind a submitted URL must not change after
    // submission, so republishing over one is an error rather than a retry.
    expect(storeWorkflow).toContain("store/${VERSION}/");
    expect(storeWorkflow).toContain("head-object");
  });

  test("installing stays per-user so the Store install needs no elevation", () => {
    // A UAC dialog is the one prompt policy 10.2.9 allows, but a per-user
    // install avoids even that. Flipping perMachine on would make every silent
    // Store install prompt for admin.
    expect(builderConfig.nsis.perMachine).toBe(false);
  });
});
