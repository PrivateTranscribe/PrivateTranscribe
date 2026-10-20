import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { findEditorFile } = require("../../../src/helpers/editorFileLocator") as {
  findEditorFile: (
    filename: string,
    folder: unknown,
    homeDir: string
  ) => { path: string | null; reason?: string };
};

const readSource = (relativePath: string) =>
  fs.readFileSync(path.join(__dirname, "../../..", relativePath), "utf8");

describe("findEditorFile", () => {
  let home: string;

  /** Writes a file under the fake home folder and returns its full path. */
  function addFile(...parts: string[]) {
    const filePath = path.join(home, ...parts);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "export const run = () => {};\n");
    return filePath;
  }

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "pt-editor-file-"));
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("finds the file in the project folder the title names, not an earlier one", () => {
    // "Desktop" sorts before "Documents", so a first-match search reads the old copy.
    addFile("Desktop", "old", "App.jsx");
    const open = addFile("Documents", "GitHub", "privoca", "App.jsx");

    expect(findEditorFile("App.jsx", "privoca", home)).toEqual({ path: open });
  });

  it("matches the folder name whatever its case", () => {
    const open = addFile("Documents", "PrivoCA", "App.jsx");

    expect(findEditorFile("App.jsx", "privoca", home).path).toBe(open);
  });

  it("finds a file further down inside the project folder", () => {
    const open = addFile("privoca", "src", "App.jsx");

    expect(findEditorFile("App.jsx", "privoca", home).path).toBe(open);
  });

  it("reads nothing when two folders of that name both hold the file", () => {
    addFile("Desktop", "privoca", "App.jsx");
    addFile("Documents", "privoca", "App.jsx");

    expect(findEditorFile("App.jsx", "privoca", home)).toEqual({
      path: null,
      reason: "more than one file with that name in that project folder",
    });
  });

  it("reads nothing when the file is only outside the project folder", () => {
    addFile("Desktop", "old", "App.jsx");

    expect(findEditorFile("App.jsx", "privoca", home)).toEqual({
      path: null,
      reason: "file not found in home dir",
    });
  });

  it.each([undefined, null, "", "  ", ".", "..", "a/b", "a\\b", 42])(
    "reads nothing without a plain folder name (%j)",
    (folder) => {
      addFile("privoca", "App.jsx");

      expect(findEditorFile("App.jsx", folder, home)).toEqual({
        path: null,
        reason: "window title names no project folder",
      });
    }
  );

  it("skips hidden folders", () => {
    addFile(".cache", "privoca", "App.jsx");

    expect(findEditorFile("App.jsx", "privoca", home).path).toBeNull();
  });

  it("stays within three folder levels below home", () => {
    addFile("a", "b", "privoca", "App.jsx");
    addFile("a", "b", "c", "privoca", "deep.js");

    expect(findEditorFile("App.jsx", "privoca", home).path).not.toBeNull();
    expect(findEditorFile("deep.js", "privoca", home).path).toBeNull();
  });
});

describe("Smart Context file IPC handlers", () => {
  it("look up the editor's file through the project folder rule", () => {
    const ipcHandlers = readSource("src/helpers/ipcHandlers.js");

    expect(ipcHandlers).not.toContain("findFileInHome");
    expect(
      ipcHandlers.match(/findEditorFile\(filename, options\?\.folder, homeDir\)/g)
    ).toHaveLength(2);
  });
});
