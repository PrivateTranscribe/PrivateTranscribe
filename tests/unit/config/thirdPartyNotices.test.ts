import { describe, expect, test } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const {
  findUncoveredFiles,
  loadManifest,
  selectShippedPackages,
} = require("../../../scripts/generate-third-party-notices");

const repoRoot = resolve(__dirname, "../../..");
const read = (relativePath: string) => readFileSync(resolve(repoRoot, relativePath), "utf8");

type LockEntry = { dev?: boolean; version: string; os?: string[]; cpu?: string[] };
type Component = { name: string; licenseText?: string | string[] };

const manifest = loadManifest();
const notices = read("THIRD_PARTY_NOTICES.md");
const lockPackages: Record<string, LockEntry> = JSON.parse(read("package-lock.json")).packages;
const listed = (name: string, version: string) => notices.includes(`\`${name}@${version}\``);
const NODE_MODULES = "node_modules/";
const nameOf = (location: string) =>
  location.slice(location.lastIndexOf(NODE_MODULES) + NODE_MODULES.length);

/**
 * resources/bin on 2026-09-29, without the leftovers electron-builder does not pack
 * (nircmd.exe, log.txt, cublas64_11.dll, cudart64_12.dll, windows-key-listener.locked-old.exe,
 * libomp140.x86_64.dll). Release builds also copy in the two sherpa-onnx API DLLs.
 */
const SHIPPED_BIN = [
  "cargs.dll",
  "ggml-base.dll",
  "ggml-cpu-alderlake.dll",
  "ggml-cpu-cannonlake.dll",
  "ggml-cpu-cascadelake.dll",
  "ggml-cpu-cooperlake.dll",
  "ggml-cpu-haswell.dll",
  "ggml-cpu-icelake.dll",
  "ggml-cpu-ivybridge.dll",
  "ggml-cpu-piledriver.dll",
  "ggml-cpu-sandybridge.dll",
  "ggml-cpu-sapphirerapids.dll",
  "ggml-cpu-skylakex.dll",
  "ggml-cpu-sse42.dll",
  "ggml-cpu-x64.dll",
  "ggml-cpu-zen4.dll",
  "ggml-rpc.dll",
  "ggml.dll",
  "GGMLCPU.dll",
  "libomp.dll",
  "llama-batched-bench-impl.dll",
  "llama-bench-impl.dll",
  "llama-cli-impl.dll",
  "llama-common.dll",
  "llama-completion-impl.dll",
  "llama-fit-params-impl.dll",
  "llama-perplexity-impl.dll",
  "llama-quantize-impl.dll",
  "llama-server-impl.dll",
  "llama-server-win32-x64.exe",
  "llama.dll",
  "msvcp140.dll",
  "msvcp140_1.dll",
  "mtmd.dll",
  "onnxruntime.dll",
  "onnxruntime_providers_shared.dll",
  "sherpa-onnx-ws-win32-x64.exe",
  "vcomp140.dll",
  "vcruntime140.dll",
  "vcruntime140_1.dll",
  "whisper-server-win32-x64.exe",
  "whisper.dll",
  "windows-fast-paste.exe",
  "windows-hold-key.exe",
  "windows-key-listener.exe",
  "windows-mic-watch.exe",
  "sherpa-onnx-c-api.dll",
  "sherpa-onnx-cxx-api.dll",
].map((name) => `bin/${name}`);

describe("third-party notices", () => {
  test("list every npm package that ships on Windows x64", () => {
    const packages: Array<{ id: string }> = selectShippedPackages({ packages: lockPackages });
    const missing = packages.map((pkg) => pkg.id).filter((id) => !notices.includes(`\`${id}\``));

    expect(packages.length).toBeGreaterThan(100);
    expect(missing, "THIRD_PARTY_NOTICES.md is out of date: run npm run notices").toEqual([]);
  });

  test("leave out macOS and Linux builds and keep the Windows x64 ones", () => {
    const platformSpecific = Object.entries(lockPackages).filter(
      ([location, entry]) => location && !entry.dev && Array.isArray(entry.os)
    );
    const foreign = platformSpecific.filter(([, entry]) => !entry.os!.includes("win32"));
    const windowsX64 = platformSpecific.filter(
      ([, entry]) => entry.os!.includes("win32") && (!entry.cpu || entry.cpu.includes("x64"))
    );
    // Without both kinds in the lock, this test would check nothing.
    expect(foreign.length).toBeGreaterThan(0);
    expect(windowsX64.length).toBeGreaterThan(0);

    const leaked = foreign.filter(([location, entry]) => listed(nameOf(location), entry.version));
    const absent = windowsX64.filter(
      ([location, entry]) => !listed(nameOf(location), entry.version)
    );
    expect(leaked.map(([location]) => location)).toEqual([]);
    expect(
      absent.map(([location]) => location),
      "THIRD_PARTY_NOTICES.md is out of date: run npm run notices"
    ).toEqual([]);
  });

  test.each([
    /^FFmpeg$/,
    /^eSpeak NG$/,
    /^whisper\.cpp$/,
    /^llama\.cpp and ggml$/,
    /^sherpa-onnx$/,
    /^ONNX Runtime$/,
    /^libvips$/,
    /^JetBrains Mono$/,
    /^Satoshi$/,
    /^Silero VAD$/,
    /^OpenWhispr$/,
    /^Microsoft Visual C\+\+ runtime$/,
    /^Electron \(with Chromium/,
  ])("has a components.json entry matching %s", (pattern) => {
    const names = manifest.components.map((component: Component) => component.name);
    expect(names.some((name: string) => pattern.test(name))).toBe(true);
  });

  test("every licence text path exists and records where it came from", () => {
    const paths = [...manifest.components, ...manifest.downloaded]
      .flatMap((component: Component) => [component.licenseText ?? []].flat())
      .filter((text: string) => /^licenses\/\S+$/.test(text));

    expect(paths.length).toBeGreaterThan(0);
    for (const path of paths) {
      expect(existsSync(resolve(repoRoot, "resources/third-party", path)), path).toBe(true);
      expect(manifest.licenseFiles[path]?.source, path).toMatch(/^https:\/\//);
    }
  });

  test("covers every file resources/bin ships today", () => {
    expect(findUncoveredFiles(SHIPPED_BIN, manifest)).toEqual([]);
  });

  test("reports a shipped file that no component covers", () => {
    expect(findUncoveredFiles([...SHIPPED_BIN, "bin/unknown.dll"], manifest)).toEqual([
      "bin/unknown.dll",
    ]);
  });
});
