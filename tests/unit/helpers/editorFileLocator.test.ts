import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { findEditorFile } = require("../../../src/helpers/editorFileLocator") as {
  findEditorFile: (
    filename: string,
    folder: unknown,
    homeDir: string,
    options?: { fsMod?: unknown; now?: () => number }
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

  it.each([".cache", "AppData", "node_modules"])("skips the %s folder", (skipped) => {
    addFile(skipped, "privoca", "App.jsx");

    expect(findEditorFile("App.jsx", "privoca", home).path).toBeNull();
  });

  it("stays within three folder levels below home", () => {
    addFile("a", "b", "privoca", "App.jsx");
    addFile("a", "b", "c", "privoca", "deep.js");

    expect(findEditorFile("App.jsx", "privoca", home).path).not.toBeNull();
    expect(findEditorFile("deep.js", "privoca", home).path).toBeNull();
  });
});

describe("findEditorFile on a large home", () => {
  const HOME = path.join(path.parse(process.cwd()).root, "Users", "alice");
  const dirent = (name: string, isDir: boolean) => ({
    name,
    isFile: () => !isDir,
    isDirectory: () => isDir,
  });

  /**
   * A home with `width` folders of `width` folders each, and the project's
   * file in zz/privoca, which a search reaches last.
   */
  function fakeHome(width: number) {
    let reads = 0;
    const many = (prefix: string) =>
      Array.from({ length: width }, (_, i) => dirent(`${prefix}${i}`, true));
    const fsMod = {
      readdirSync: (dir: string) => {
        reads += 1;
        const rel = path.relative(HOME, dir);
        if (rel === "") return [...many("f"), dirent("zz", true)];
        if (rel === "zz") return [dirent("privoca", true)];
        if (rel === path.join("zz", "privoca")) return [dirent("App.jsx", false)];
        return rel.includes(path.sep) ? [] : many("g");
      },
    };
    return { fsMod, reads: () => reads };
  }

  it("finds the file in a home with a few hundred folders", () => {
    const { fsMod, reads } = fakeHome(20);

    expect(findEditorFile("App.jsx", "privoca", HOME, { fsMod }).path).toBe(
      path.join(HOME, "zz", "privoca", "App.jsx")
    );
    expect(reads()).toBe(1 + 20 + 400 + 2);
  });

  it("reads no file once the search passes 1,000 folders", () => {
    const { fsMod, reads } = fakeHome(40);

    expect(findEditorFile("App.jsx", "privoca", HOME, { fsMod })).toEqual({
      path: null,
      reason: "too many folders to search",
    });
    expect(reads()).toBe(1000);
  });

  it("searches once for the same file within five seconds", () => {
    const { fsMod, reads } = fakeHome(3);
    const at = (ms: number) => () => ms;

    const first = findEditorFile("App.jsx", "privoca", HOME, { fsMod, now: at(1000) });
    const readsForOne = reads();
    const again = findEditorFile("App.jsx", "privoca", HOME, { fsMod, now: at(5999) });

    expect(again).toEqual(first);
    expect(reads()).toBe(readsForOne);

    findEditorFile("App.jsx", "privoca", HOME, { fsMod, now: at(6000) });
    expect(reads()).toBe(readsForOne * 2);
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
