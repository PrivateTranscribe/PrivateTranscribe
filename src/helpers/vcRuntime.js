"use strict";

// Dependency free on purpose: the build scripts and the CUDA engine workflow
// require this file with no node_modules installed.
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");

// Windows finds these only in the importing file's own folder or in System32, and
// System32 has them only where the Visual C++ redistributable is installed.
const VC_RUNTIME_DLL =
  /^(msvcp140(_\w+)?|vcruntime140(_\w+)?|vcomp140|concrt140|vccorlib140)\.dll$/i;

// The runtime the app ships in resources/bin and hands to engines it downloads.
// msvcp140_1.dll imports msvcp140.dll and vcruntime140.dll, so they travel as one
// set. vcomp140.dll is the OpenMP runtime the ggml CPU backend uses.
const VC_RUNTIME_LIBRARIES = [
  "msvcp140.dll",
  "msvcp140_1.dll",
  "vcruntime140.dll",
  "vcruntime140_1.dll",
  "vcomp140.dll",
];

async function readIfPresent(filePath) {
  try {
    return await fsp.readFile(filePath);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

/**
 * Makes each runtime library in toDir match the app's copy in fromDir, so an
 * engine there finds the runtime in its own folder before Windows looks in
 * System32. Writes only a file that is missing or different, and never throws:
 * a failure leaves the engine where it was, relying on System32.
 */
async function provideVcRuntime({ fromDir, toDir }) {
  const result = { copied: [], unchanged: [], missing: [], failed: [] };
  for (const name of VC_RUNTIME_LIBRARIES) {
    try {
      const source = await readIfPresent(path.join(fromDir, name));
      if (!source) {
        result.missing.push(name);
        continue;
      }
      const target = path.join(toDir, name);
      const existing = await readIfPresent(target);
      if (existing && existing.equals(source)) {
        result.unchanged.push(name);
        continue;
      }
      // Write beside it and rename, so an engine starting meanwhile never
      // loads half a DLL.
      const temp = `${target}.tmp`;
      await fsp.writeFile(temp, source);
      await fsp.rename(temp, target);
      result.copied.push(name);
    } catch (error) {
      result.failed.push({ name, error: error.message });
      await fsp.rm(path.join(toDir, `${name}.tmp`), { force: true }).catch(() => {});
    }
  }
  return result;
}

module.exports = { VC_RUNTIME_DLL, VC_RUNTIME_LIBRARIES, provideVcRuntime };
