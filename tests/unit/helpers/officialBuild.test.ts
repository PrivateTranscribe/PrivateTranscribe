import fs from "node:fs";
import Module, { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);

type ModuleLoader = (request: string, parent: unknown, isMain: boolean) => unknown;
const moduleWithLoader = Module as unknown as { _load: ModuleLoader };
const originalLoad = moduleWithLoader._load;

// Where Electron would say the app lives; each test gives it its own package.json.
let appPath = "";

moduleWithLoader._load = (request, parent, isMain) => {
  if (request === "electron") {
    return { app: { getAppPath: () => appPath } };
  }
  return originalLoad(request, parent, isMain);
};

const {
  OFFICIAL_BUILD_OVERRIDE_ENV,
  hasOfficialBuildFlag,
  isOfficialBuild,
} = require("../../../src/helpers/officialBuild");

const savedOverride = process.env[OFFICIAL_BUILD_OVERRIDE_ENV];

function writePackageJson(fields: Record<string, unknown>) {
  fs.writeFileSync(
    path.join(appPath, "package.json"),
    JSON.stringify({ name: "privatetranscribe", version: "0.20.2", ...fields })
  );
}

beforeEach(() => {
  appPath = fs.mkdtempSync(path.join(os.tmpdir(), "pt-official-build-"));
  delete process.env[OFFICIAL_BUILD_OVERRIDE_ENV];
});

afterEach(() => {
  fs.rmSync(appPath, { recursive: true, force: true });
  if (savedOverride === undefined) {
    delete process.env[OFFICIAL_BUILD_OVERRIDE_ENV];
  } else {
    process.env[OFFICIAL_BUILD_OVERRIDE_ENV] = savedOverride;
  }
});

afterAll(() => {
  moduleWithLoader._load = originalLoad;
});

describe("official build flag", () => {
  it.each([
    { name: "boolean true", value: true, official: true },
    { name: 'the string "true"', value: "true", official: true },
    { name: "false", value: false, official: false },
    { name: 'the string "false"', value: "false", official: false },
    { name: "1", value: 1, official: false },
    { name: '"yes"', value: "yes", official: false },
  ])("reads $name as official: $official", ({ value, official }) => {
    expect(hasOfficialBuildFlag({ privatetranscribeOfficialBuild: value })).toBe(official);
  });

  it("treats a package.json without the flag as a copy built from source", () => {
    expect(hasOfficialBuildFlag({ name: "privatetranscribe" })).toBe(false);
    expect(hasOfficialBuildFlag(null)).toBe(false);
  });

  it("reads the flag from the package.json in the app path", () => {
    writePackageJson({ privatetranscribeOfficialBuild: true });
    expect(isOfficialBuild()).toBe(true);

    writePackageJson({ privatetranscribeOfficialBuild: "true" });
    expect(isOfficialBuild()).toBe(true);

    writePackageJson({});
    expect(isOfficialBuild()).toBe(false);
  });

  it("fails closed when package.json is missing or unreadable", () => {
    expect(isOfficialBuild()).toBe(false);

    fs.writeFileSync(path.join(appPath, "package.json"), "{ not json");
    expect(isOfficialBuild()).toBe(false);
  });

  it("lets the test override force official behaviour", () => {
    writePackageJson({});
    process.env[OFFICIAL_BUILD_OVERRIDE_ENV] = "1";

    expect(isOfficialBuild()).toBe(true);
  });

  it.each(["true", "yes", "0", ""])("ignores the override set to %j", (value) => {
    writePackageJson({});
    process.env[OFFICIAL_BUILD_OVERRIDE_ENV] = value;

    expect(isOfficialBuild()).toBe(false);
  });
});
