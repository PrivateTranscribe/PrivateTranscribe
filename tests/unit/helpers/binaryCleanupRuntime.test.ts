import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";

const { cleanupFiles } = require("../../../scripts/lib/download-utils");

it.each([
  { prefix: "llama-server", keep: "llama-server-win32-x64", libraries: ["llama-server-impl.dll"] },
])("keeps $prefix companion libraries during CI cleanup", ({ prefix, keep, libraries }) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-cleanup-runtime-"));
  try {
    for (const file of [keep + ".exe", prefix + "-linux-x64", ...libraries])
      fs.writeFileSync(path.join(dir, file), "runtime");
    cleanupFiles(dir, prefix, keep);
    expect(fs.existsSync(path.join(dir, keep + ".exe"))).toBe(true);
    expect(fs.existsSync(path.join(dir, prefix + "-linux-x64"))).toBe(false);
    for (const file of libraries) expect(fs.existsSync(path.join(dir, file)), file).toBe(true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
