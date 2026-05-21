import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("useLocalStorage same-window sync", () => {
  const readHook = () =>
    fs.readFileSync(path.join(process.cwd(), "src", "hooks", "useLocalStorage.ts"), "utf8");

  const readSidebar = () =>
    fs.readFileSync(path.join(process.cwd(), "src", "components", "AppSidebar.tsx"), "utf8");

  it("dispatches a same-window change event when localStorage values are updated", () => {
    const contents = readHook();

    expect(contents).toContain("privatetranscribe-local-storage-change");
    expect(contents).toContain("window.dispatchEvent(");
    expect(contents).toContain("window.addEventListener(LOCAL_STORAGE_CHANGE_EVENT");
    expect(contents).toContain('window.addEventListener("storage"');
  });

  it("renders the sidebar hotkey from the synchronized localStorage hook", () => {
    const contents = readSidebar();

    expect(contents).toContain('useLocalStorage("dictationKey"');
    expect(contents).not.toContain('localStorage.getItem("dictationKey")');
  });
});
