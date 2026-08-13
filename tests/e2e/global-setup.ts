import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const RENDERER_SRC = path.join(REPO_ROOT, "src");
const RENDERER_DIST = path.join(RENDERER_SRC, "dist");
const RENDERER_ENTRY = path.join(RENDERER_DIST, "index.html");

// Directories under src/ that are not renderer inputs, so changes in them must
// not trigger a rebuild.
const IGNORED_DIRS = new Set(["dist", "node_modules", "assets"]);
const RENDERER_EXTENSIONS = new Set([".js", ".jsx", ".ts", ".tsx", ".css", ".json", ".mjs"]);

/**
 * Newest modification time across renderer sources. Used to detect a stale
 * bundle so a spec never silently asserts against yesterday's UI.
 */
function newestSourceMtime(dir: string): number {
  let newest = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      newest = Math.max(newest, newestSourceMtime(path.join(dir, entry.name)));
      continue;
    }
    if (!RENDERER_EXTENSIONS.has(path.extname(entry.name))) continue;
    newest = Math.max(newest, fs.statSync(path.join(dir, entry.name)).mtimeMs);
  }
  return newest;
}

function needsBuild(): { build: boolean; reason: string } {
  if (!fs.existsSync(RENDERER_ENTRY)) {
    return { build: true, reason: "src/dist/index.html is missing" };
  }
  const builtAt = fs.statSync(RENDERER_ENTRY).mtimeMs;
  const sourcedAt = newestSourceMtime(RENDERER_SRC);
  if (sourcedAt > builtAt) {
    return { build: true, reason: "renderer sources are newer than src/dist" };
  }
  return { build: false, reason: "src/dist is up to date" };
}

/**
 * The e2e suite runs the app in production mode, where windowManager loads
 * `src/dist/index.html` from disk instead of the Vite dev server. That bundle
 * has to exist and be current before any spec launches Electron.
 *
 * Set PT_E2E_SKIP_BUILD=1 to reuse whatever is already in src/dist.
 */
export default function globalSetup(): void {
  if (process.env.PT_E2E_SKIP_BUILD === "1") {
    if (!fs.existsSync(RENDERER_ENTRY)) {
      throw new Error(
        "PT_E2E_SKIP_BUILD=1 but src/dist/index.html does not exist. " +
          "Run `npm run build:renderer` first, or unset the flag."
      );
    }
    console.log("[e2e] Skipping renderer build (PT_E2E_SKIP_BUILD=1)");
    return;
  }

  const { build, reason } = needsBuild();
  if (!build) {
    console.log(`[e2e] Reusing renderer bundle — ${reason}`);
    return;
  }

  console.log(`[e2e] Building renderer — ${reason}`);

  // Same work as `npm run build:renderer`, but calling vite's entry with the
  // current Node binary. Spawning npm.cmd through execFile fails with EINVAL on
  // Windows since Node 18.20/20.12 tightened .cmd handling.
  // vite's package exports hide ./bin/vite.js from require.resolve, so reach it
  // through the installed package directory instead.
  const viteBin = path.join(REPO_ROOT, "node_modules", "vite", "bin", "vite.js");
  if (!fs.existsSync(viteBin)) {
    throw new Error(`Cannot find vite at ${viteBin}. Run \`npm install\` first.`);
  }
  execFileSync(process.execPath, [viteBin, "build"], {
    cwd: RENDERER_SRC,
    stdio: "inherit",
  });
}
