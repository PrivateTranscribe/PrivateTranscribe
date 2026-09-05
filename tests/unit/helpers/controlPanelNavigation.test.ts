import { describe, expect, test } from "vitest";
import fs from "node:fs";
import path from "node:path";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { normalizeControlPanelDestination } = require("../../../src/helpers/controlPanelNavigation");

describe("control panel navigation", () => {
  test("accepts known pages and settings tabs", () => {
    expect(normalizeControlPanelDestination({ page: "history" })).toEqual({ page: "history" });
    expect(
      normalizeControlPanelDestination({ page: "settings", settingsTab: "permissions" })
    ).toEqual({ page: "settings", settingsTab: "permissions" });
  });

  test("drops unknown routes and tabs", () => {
    expect(normalizeControlPanelDestination({ page: "unknown" })).toBeNull();
    expect(normalizeControlPanelDestination({ page: "settings", settingsTab: "unknown" })).toEqual({
      page: "settings",
    });
    expect(normalizeControlPanelDestination({ page: "history", settingsTab: "general" })).toEqual({
      page: "history",
    });
  });

  test("forwards overlay destinations and makes explicit opens visible", () => {
    const app = fs.readFileSync(path.resolve("src/App.jsx"), "utf8");
    const preload = fs.readFileSync(path.resolve("preload.js"), "utf8");
    const ipcHandlers = fs.readFileSync(path.resolve("src/helpers/ipcHandlers.js"), "utf8");
    const windowManager = fs.readFileSync(path.resolve("src/helpers/windowManager.js"), "utf8");
    const controlPanel = fs.readFileSync(
      path.resolve("src/components/ControlPanelShell.tsx"),
      "utf8"
    );

    expect(app).toContain("openControlPanel({ page, settingsTab })");
    expect(preload).toContain('ipcRenderer.invoke("open-control-panel", destination)');
    expect(ipcHandlers).toContain("this.windowManager.openControlPanel(destination)");
    expect(windowManager).toContain(
      "createControlPanelWindow({ startHidden: false, startMinimized: false })"
    );
    expect(windowManager).toContain('webContents.send("control-panel-navigate"');
    expect(controlPanel).toContain("onControlPanelNavigate");
  });
});
