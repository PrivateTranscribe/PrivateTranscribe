// Checks a Windows CUDA engine package before it is signed and published.
// The app copies its Visual C++ runtime beside the engine before starting it
// (GpuBinaryManager.provideCudaRuntime), so the engine may import only runtime
// DLLs from that set, and must not carry its own copies, which the app would
// overwrite. Needs no node_modules, because the CUDA workflow installs none.
// Usage: node scripts/check-cuda-runtime.js <packageDir>
const path = require("path");
const { readdirSync, readFileSync } = require("fs");
const { readImports } = require("./lib/pe-file");
const { VC_RUNTIME_DLL, VC_RUNTIME_LIBRARIES } = require("../src/helpers/vcRuntime");

/** Every problem with the package, as a sentence each. Empty means it passes. */
function findCudaRuntimeProblems(packageDir, provided = VC_RUNTIME_LIBRARIES) {
  const providedNames = new Set(provided.map((name) => name.toLowerCase()));
  const problems = [];
  for (const name of readdirSync(packageDir)) {
    if (VC_RUNTIME_DLL.test(name)) {
      problems.push(`${name} is in the package, and the app would overwrite it with its own copy`);
      continue;
    }
    if (!/\.(exe|dll)$/i.test(name)) continue;
    const pe = readImports(readFileSync(path.join(packageDir, name)));
    if (!pe) continue;
    for (const dll of [...pe.imports, ...pe.delayImports]) {
      if (VC_RUNTIME_DLL.test(dll) && !providedNames.has(dll.toLowerCase())) {
        problems.push(`${name} needs ${dll}, which the app does not provide`);
      }
    }
  }
  return problems;
}

if (require.main === module) {
  const packageDir = process.argv[2];
  if (!packageDir) {
    console.error("Usage: node scripts/check-cuda-runtime.js <packageDir>");
    process.exit(2);
  }
  const problems = findCudaRuntimeProblems(packageDir);
  if (problems.length > 0) {
    console.error(
      `[cuda-runtime] ${problems.join("; ")}. The app provides ${VC_RUNTIME_LIBRARIES.join(", ")} ` +
        "from resources/bin (src/helpers/vcRuntime.js)."
    );
    process.exit(1);
  }
  console.log(`[cuda-runtime] The engine needs only runtime DLLs the app provides.`);
}

module.exports = { findCudaRuntimeProblems };
