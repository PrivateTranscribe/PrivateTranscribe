import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

const root = resolve(__dirname, "../../..");
const read = (file: string) => readFileSync(resolve(root, file), "utf8");
const lock = JSON.parse(read("package-lock.json"));
const manifest = JSON.parse(read("resources/third-party/components.json"));

describe("Electron dependency requirements", () => {
  test("records the installed Electron version in the bundled notices manifest", () => {
    const version = lock.packages["node_modules/electron"].version;
    const component = manifest.components.find((entry: { name: string }) =>
      entry.name.startsWith("Electron (")
    );
    expect(component.version).toBe(version);
    expect(component.source).toBe(`https://github.com/electron/electron/tree/v${version}`);
  });

  test.each(["accuracy.yml", "build-windows.yml", "build-store.yml", "ci.yml", "release.yml"])(
    "%s installs a supported Node major for Electron's downloader",
    (workflow) => {
      const versions = [
        ...read(`.github/workflows/${workflow}`).matchAll(/node-version:\s*["']?(\d+)/g),
      ];
      expect(versions.length).toBeGreaterThan(0);
      for (const version of versions) expect(Number(version[1])).toBeGreaterThanOrEqual(22);
    }
  );
});
