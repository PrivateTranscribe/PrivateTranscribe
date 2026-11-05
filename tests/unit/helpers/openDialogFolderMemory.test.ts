import { describe, expect, test } from "vitest";
import os from "node:os";
import path from "node:path";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createOpenDialogFolderMemory } = require("../../../src/helpers/openDialogFolderMemory");

const appsFolder = path.join(os.tmpdir(), "pt-dialog", "apps");
const projectsFolder = path.join(os.tmpdir(), "pt-dialog", "projects");

describe("open dialog folder memory", () => {
  test("leaves the first dialog to Electron's default", () => {
    const memory = createOpenDialogFolderMemory();
    expect(memory.defaultPath(undefined)).toBeUndefined();
  });

  test("reopens in the folder of the last picked file", () => {
    const memory = createOpenDialogFolderMemory();
    memory.remember({ canceled: false, filePaths: [path.join(appsFolder, "tool.exe")] });
    expect(memory.defaultPath(undefined)).toBe(appsFolder);
  });

  test("reopens beside the last picked folder, where the user browsed", () => {
    const memory = createOpenDialogFolderMemory();
    memory.remember({ canceled: false, filePaths: [path.join(projectsFolder, "site")] });
    expect(memory.defaultPath(undefined)).toBe(projectsFolder);
  });

  test("keeps the last folder when a dialog is cancelled or picks nothing", () => {
    const memory = createOpenDialogFolderMemory();
    memory.remember({ canceled: false, filePaths: [path.join(appsFolder, "tool.exe")] });
    memory.remember({ canceled: true, filePaths: [] });
    memory.remember({ canceled: false, filePaths: [] });
    memory.remember(undefined);
    expect(memory.defaultPath(undefined)).toBe(appsFolder);
  });

  test("lets a caller's own defaultPath win, and ignores an empty one", () => {
    const memory = createOpenDialogFolderMemory();
    memory.remember({ canceled: false, filePaths: [path.join(appsFolder, "tool.exe")] });
    expect(memory.defaultPath(projectsFolder)).toBe(projectsFolder);
    expect(memory.defaultPath("")).toBe(appsFolder);
  });
});
