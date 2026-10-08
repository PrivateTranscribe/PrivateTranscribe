const path = require("path");
const { existsSync, readdirSync, readFileSync } = require("fs");
const { execFileSync } = require("child_process");
const { Arch } = require("electron-builder");
const { findUncoveredFiles, loadManifest } = require("./generate-third-party-notices");
const { MACHINE, readImports } = require("./lib/pe-file");
const { VC_RUNTIME_DLL, VC_RUNTIME_LIBRARIES } = require("../src/helpers/vcRuntime");

function listFiles(dir, prefix) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const relativePath = `${prefix}/${entry.name}`;
    return entry.isDirectory()
      ? listFiles(path.join(dir, entry.name), relativePath)
      : [relativePath];
  });
}

/**
 * Binaries of one machine type under dir that import a Visual C++ runtime DLL
 * missing from their own folder, as "relative/path needs NAME.dll". Other
 * architectures are skipped: onnxruntime-node also ships arm64 copies that never load.
 */
function findUnshippedRuntimeImports(dir, machine) {
  return listFiles(dir, ".")
    .filter((file) => /\.(exe|dll|node)$/i.test(file))
    .flatMap((file) => {
      const fullPath = path.join(dir, file);
      const pe = readImports(readFileSync(fullPath));
      if (!pe || pe.machine !== machine) return [];
      const neighbours = new Set(
        readdirSync(path.dirname(fullPath)).map((name) => name.toLowerCase())
      );
      return [...pe.imports, ...pe.delayImports]
        .filter((dll) => VC_RUNTIME_DLL.test(dll) && !neighbours.has(dll.toLowerCase()))
        .map((dll) => `${file.slice(2)} needs ${dll}`);
    });
}

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== "win32") {
    return;
  }

  // Probe the packaged copies from their own runtime directory.
  // Source tests can find a working engine in the user's cache and miss stale
  // DLLs in resources/bin. Help must work before signing or publishing a build.
  const binDir = path.join(context.appOutDir, "resources", "bin");
  for (const name of ["whisper-server-win32-x64.exe", "llama-server-win32-x64.exe"]) {
    try {
      execFileSync(path.join(binDir, name), ["--help"], {
        cwd: binDir,
        windowsHide: true,
        timeout: 15000,
        stdio: "pipe",
      });
    } catch (error) {
      throw new Error(
        `Packaged ${name} cannot start (exit ${error.status ?? "unknown"}). ` +
          "Refresh its CPU binary and matching runtime libraries before rebuilding."
      );
    }
  }

  if (!existsSync(path.join(context.appOutDir, "resources", "THIRD_PARTY_NOTICES.md"))) {
    throw new Error(
      "[after-pack-win] resources/THIRD_PARTY_NOTICES.md is missing from the package"
    );
  }
  const uncovered = findUncoveredFiles(listFiles(binDir, "bin"), loadManifest());
  if (uncovered.length > 0) {
    throw new Error(
      `[after-pack-win] No third-party notice covers ${uncovered.join(", ")}. ` +
        "Add each file to resources/third-party/components.json, then run npm run notices."
    );
  }

  // The probes above cannot catch this: the build machine has the runtime in System32.
  const unshipped = findUnshippedRuntimeImports(context.appOutDir, MACHINE[Arch[context.arch]]);
  if (unshipped.length > 0) {
    throw new Error(
      `[after-pack-win] ${unshipped.join(", ")}. Windows looks for these in the importing ` +
        "file's folder, then in System32, which has them only where the Visual C++ " +
        "redistributable is installed. Ship them with scripts/copy-vc-runtime.js and " +
        "electron-builder.json."
    );
  }

  // The app copies these beside the downloaded CUDA engine before starting it,
  // and nothing packaged here may need them, so the check above cannot notice one.
  const missingForCuda = VC_RUNTIME_LIBRARIES.filter(
    (name) => !existsSync(path.join(binDir, name))
  );
  if (missingForCuda.length > 0) {
    throw new Error(
      `[after-pack-win] resources/bin lacks ${missingForCuda.join(", ")}, which the app ` +
        "copies beside the CUDA engine. Without them GPU transcription starts only where " +
        "the Visual C++ redistributable is installed."
    );
  }

  const appInfo = context.packager.appInfo;
  const productFilename = appInfo.productFilename;
  const exePath = path.join(context.appOutDir, `${productFilename}.exe`);
  const projectDir = context.packager.projectDir;
  const iconPath = path.join(projectDir, "src", "assets", "icon.ico");
  const rceditPath = path.join(
    projectDir,
    "node_modules",
    "electron-winstaller",
    "vendor",
    "rcedit.exe"
  );

  if (!existsSync(exePath)) {
    throw new Error(`[after-pack-win] Executable not found: ${exePath}`);
  }
  if (!existsSync(iconPath)) {
    throw new Error(`[after-pack-win] Icon not found: ${iconPath}`);
  }
  if (!existsSync(rceditPath)) {
    throw new Error(`[after-pack-win] rcedit not found: ${rceditPath}`);
  }

  const fileVersion = appInfo.shortVersion || appInfo.buildVersion || appInfo.version;
  const productVersion = appInfo.shortVersionWindows || appInfo.getVersionInWeirdWindowsForm();
  const originalFilename = `${productFilename}.exe`;

  const args = [
    exePath,
    "--set-icon",
    iconPath,
    "--set-version-string",
    "FileDescription",
    appInfo.productName,
    "--set-version-string",
    "ProductName",
    appInfo.productName,
    "--set-version-string",
    "InternalName",
    productFilename,
    "--set-version-string",
    "OriginalFilename",
    originalFilename,
    "--set-version-string",
    "AppUserModelID",
    appInfo.id,
    "--set-file-version",
    fileVersion,
    "--set-product-version",
    productVersion,
  ];

  if (appInfo.companyName) {
    args.push("--set-version-string", "CompanyName", appInfo.companyName);
  }
  if (appInfo.copyright) {
    args.push("--set-version-string", "LegalCopyright", appInfo.copyright);
  }

  execFileSync(rceditPath, args, { stdio: "inherit" });
  console.log(`[after-pack-win] Updated Windows metadata for ${originalFilename}`);
};

module.exports.findUnshippedRuntimeImports = findUnshippedRuntimeImports;
