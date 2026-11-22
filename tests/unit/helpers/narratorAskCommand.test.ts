import { describe, expect, it } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { askCommand } = require("../../../src/helpers/narrator/askServer");

/** A Windows user's folders, as the app sees them. */
const VARS = {
  APPDATA: "C:\\Users\\someone\\AppData\\Roaming",
  LOCALAPPDATA: "C:\\Users\\someone\\AppData\\Local",
  ProgramFiles: "C:\\Program Files",
};

describe("the command that connects Claude Code to ask_by_voice", () => {
  it("runs the bridge with node from a development copy, and names no user", () => {
    const line = askCommand({
      userData: "C:\\Users\\someone\\AppData\\Roaming\\PrivateTranscribe",
      execPath: "C:\\code\\PrivateTranscribe\\node_modules\\electron\\dist\\electron.exe",
      packaged: false,
      platform: "win32",
      vars: VARS,
    });
    expect(line).toBe(
      'claude mcp add --scope user privatetranscribe -- node "$env:APPDATA\\PrivateTranscribe\\ask-by-voice-mcp.cjs"'
    );
    expect(line).not.toContain("someone");
  });

  it("runs the bridge with the installed app itself, so no Node install is needed", () => {
    const perUser = askCommand({
      userData: "C:\\Users\\someone\\AppData\\Roaming\\PrivateTranscribe",
      execPath:
        "C:\\Users\\someone\\AppData\\Local\\Programs\\PrivateTranscribe\\PrivateTranscribe.exe",
      packaged: true,
      platform: "win32",
      vars: VARS,
    });
    // The name comes before --env: Claude Code reads every word after --env up
    // to the next option as a variable, and refuses a name there.
    expect(perUser).toBe(
      'claude mcp add --scope user privatetranscribe --env ELECTRON_RUN_AS_NODE=1 -- "$env:LOCALAPPDATA\\Programs\\PrivateTranscribe\\PrivateTranscribe.exe" "$env:APPDATA\\PrivateTranscribe\\ask-by-voice-mcp.cjs"'
    );

    const allUsers = askCommand({
      userData: "C:\\Users\\someone\\AppData\\Roaming\\PrivateTranscribe",
      execPath: "C:\\Program Files\\PrivateTranscribe\\PrivateTranscribe.exe",
      packaged: true,
      platform: "win32",
      vars: VARS,
    });
    expect(allUsers).toContain('-- "$env:ProgramFiles\\PrivateTranscribe\\PrivateTranscribe.exe"');
  });

  it("keeps a data folder outside the user's folders as it is", () => {
    const line = askCommand({
      userData: "D:\\Portable\\PrivateTranscribe Data",
      packaged: false,
      platform: "win32",
      vars: VARS,
    });
    expect(line).toBe(
      'claude mcp add --scope user privatetranscribe -- node "D:\\Portable\\PrivateTranscribe Data\\ask-by-voice-mcp.cjs"'
    );
  });

  it("does not take a folder that only starts with the same letters for the user's folder", () => {
    const line = askCommand({
      userData: "C:\\Users\\someone\\AppData\\RoamingOther\\PrivateTranscribe",
      packaged: false,
      platform: "win32",
      vars: VARS,
    });
    expect(line).not.toContain("$env:APPDATA");
  });

  it("quotes a path for a POSIX shell off Windows", () => {
    const line = askCommand({
      userData: "/home/someone/.config/PrivateTranscribe",
      packaged: false,
      platform: "linux",
      vars: {},
    });
    expect(line).toBe(
      "claude mcp add --scope user privatetranscribe -- node '/home/someone/.config/PrivateTranscribe/ask-by-voice-mcp.cjs'"
    );
  });
});
