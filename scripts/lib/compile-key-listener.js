/**
 * Compiles resources/windows-key-listener.c with the first C compiler found.
 *
 * Shared by `npm run compile:winkeys` and the listener's unit tests, so a test
 * runs the source as it is now, built the way the app gets it.
 *
 * Compilers already on PATH come first: release builds find MinGW gcc on the
 * GitHub runner, and this order keeps them on it. Last comes the Visual Studio
 * C++ toolset located through vswhere. A Visual Studio or Build Tools install
 * puts nothing on PATH outside its developer prompt, so without that step a PC
 * with the compiler installed could not build the listener and kept whatever
 * binary it already had.
 */

const { execFileSync, spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

function quotePath(p) {
  // Windows paths cannot contain a double quote, and cmd.exe has no escape
  // for one inside quotes, so refuse rather than build a broken command.
  if (p.includes('"')) throw new Error(`Path contains a double quote: ${p}`);
  return `"${p}"`;
}

function isOnPath(command) {
  return spawnSync("where", [command], { stdio: "ignore" }).status === 0;
}

/** vcvars64.bat of the newest Visual Studio install with the x64 C++ tools, or null. */
function findVcvars64() {
  const vswhere = path.join(
    process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)",
    "Microsoft Visual Studio",
    "Installer",
    "vswhere.exe"
  );
  if (!fs.existsSync(vswhere)) return null;

  let installPath;
  try {
    installPath = execFileSync(
      vswhere,
      [
        "-latest",
        "-products",
        "*",
        "-requires",
        "Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
        "-property",
        "installationPath",
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
    )
      .split(/\r?\n/)
      .find(Boolean);
  } catch {
    return null;
  }
  if (!installPath) return null;

  const vcvars = path.join(installPath, "VC", "Auxiliary", "Build", "vcvars64.bat");
  return fs.existsSync(vcvars) ? vcvars : null;
}

/** Runs one cmd.exe command line exactly as written. */
function runCmd(commandLine, stdio) {
  return spawnSync("cmd.exe", ["/d", "/s", "/c", `"${commandLine}"`], {
    stdio,
    windowsVerbatimArguments: true,
  });
}

/**
 * Builds the listener at `output`.
 *
 * `compiler` names the compiler that built it, or is null. `failures` lists the
 * compilers that were found but rejected the source, with their output when
 * `quiet` captured it: no compiler and a broken source are different problems.
 *
 * @param {object} options
 * @param {string} options.source - path to windows-key-listener.c
 * @param {string} options.output - path of the .exe to write
 * @param {boolean} [options.quiet=false] - capture compiler output instead of printing it
 * @param {(message: string) => void} [options.log] - progress messages
 * @returns {{ compiler: string | null, failures: Array<{ compiler: string, output: string }> }}
 */
function compileKeyListener({ source, output, quiet = false, log = () => {} }) {
  const failures = [];
  if (process.platform !== "win32") return { compiler: null, failures };

  const stdio = quiet ? "pipe" : "inherit";
  // cl writes an object file into its working directory unless told otherwise.
  const objectFile = path.join(
    os.tmpdir(),
    `windows-key-listener-${process.pid}-${Date.now()}.obj`
  );
  const cl = `cl /O2 /nologo ${quotePath(source)} /Fe:${quotePath(output)} /Fo:${quotePath(objectFile)} user32.lib`;

  const compilers = [
    {
      name: "MSVC",
      available: () => isOnPath("cl"),
      run: () => runCmd(cl, stdio),
    },
    {
      name: "MinGW-w64",
      available: () => isOnPath("gcc"),
      run: () =>
        spawnSync("gcc", ["-O2", "-mwindows", source, "-o", output, "-luser32"], { stdio }),
    },
    {
      name: "Clang",
      available: () => isOnPath("clang"),
      run: () => spawnSync("clang", ["-O2", source, "-o", output, "-luser32"], { stdio }),
    },
    {
      name: "MSVC (Visual Studio, found by vswhere)",
      available: () => Boolean(findVcvars64()),
      run: () => runCmd(`call ${quotePath(findVcvars64())} >nul && ${cl}`, stdio),
    },
  ];

  try {
    for (const compiler of compilers) {
      if (!compiler.available()) {
        log(`${compiler.name} not found, trying next...`);
        continue;
      }
      log(`Compiling with ${compiler.name}...`);
      const result = compiler.run();
      if (result.status === 0 && fs.existsSync(output)) {
        return { compiler: compiler.name, failures };
      }
      log(`${compiler.name} compilation failed, trying next...`);
      failures.push({
        compiler: compiler.name,
        output: `${result.stdout || ""}${result.stderr || ""}`.trim(),
      });
    }
    return { compiler: null, failures };
  } finally {
    fs.rmSync(objectFile, { force: true });
  }
}

module.exports = { compileKeyListener };
