import path from "node:path";
import { expect, test } from "./fixtures/electron-app";
import { unlockTesterAccess } from "./fixtures/tester-access";

test.use({
  appEnv: {
    PRIVATETRANSCRIBE_DIAG_DISABLE_AGENT_REWRITE: "",
    PT_CONVERSE_CLAUDE_BIN: process.execPath,
    PT_CONVERSE_CLAUDE_ARGS: JSON.stringify([
      path.resolve(__dirname, "fixtures/claude-print-stub.cjs"),
    ]),
  },
});

test("Claude Code enhances both styles and the shared shortcut settings persist", async ({
  controlPanel: page,
  electronApp,
}) => {
  await unlockTesterAccess(page);
  await page.getByRole("button", { name: "AI Enhancement", exact: true }).click();
  await page.getByRole("button", { name: "Enable AI enhancement", exact: true }).click();
  await page.getByRole("combobox", { name: "Enhance using", exact: true }).click();
  await page.getByRole("option", { name: "Claude Code", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Claude Code is installed");
  await page.getByRole("button", { name: "Try cleanup", exact: true }).click();
  await expect(page.getByTestId("cleanup-result")).toContainText("Fix the crash");
  await page.getByRole("tab", { name: "Coding prompt", exact: true }).click();
  await page.getByRole("button", { name: "Try coding prompt", exact: true }).click();
  await expect(page.getByTestId("cleanup-result")).toContainText("Fix the crash");
  const shortcut = page.locator("summary").filter({ hasText: "Coding prompt shortcut" });
  await shortcut.click();
  await expect(
    page.getByRole("combobox", { name: "Shortcut AI connection", exact: true })
  ).toContainText("Same as AI Enhancement");
  await page.getByRole("button", { name: "Enable coding prompt shortcut", exact: true }).click();
  await expect(
    page.getByRole("combobox", { name: "Coding prompt hotkey", exact: true })
  ).toBeDisabled();
  await page.getByRole("button", { name: "Enable coding prompt shortcut", exact: true }).click();
  await page.getByRole("combobox", { name: "Coding prompt hotkey", exact: true }).click();
  await page.getByRole("option", { name: "Right Alt", exact: true }).click();
  await page.getByRole("button", { name: "Dictation", exact: true }).click();
  await expect(page.locator("summary").filter({ hasText: "Agent Mode" })).toHaveCount(0);
  await page.getByRole("button", { name: "AI Enhancement", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "Enhance using", exact: true })).toContainText(
    "Claude Code"
  );
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("enhancementWritingStyle")))
    .toBe("coding");
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("agentModeHotkey")))
    .toBe("RightAlt");
  // A failed connection never displays a stale success result.
  await electronApp.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler("enhance-with-claude-code");
    ipcMain.handle("enhance-with-claude-code", () => ({
      ok: false,
      message: "Sign in to Claude Code",
    }));
  });
  await page.getByRole("button", { name: "Try coding prompt", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Sign in to Claude Code");
  await expect(page.getByTestId("cleanup-result")).toHaveCount(0);
});

test("Starter can still configure coding shortcuts without tester access", async ({
  controlPanel: page,
}) => {
  await page.getByRole("button", { name: "AI Enhancement", exact: true }).click();
  await expect(page.getByText("Dictation enhancement is in beta", { exact: true })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Enhance using", exact: true })).toHaveCount(0);
  await page.locator("summary").filter({ hasText: "Coding prompt shortcut" }).click();
  await expect(
    page.getByRole("button", { name: "Enhance coding prompts", exact: true })
  ).toBeEnabled();
  await expect(
    page.getByRole("combobox", { name: "Shortcut AI connection", exact: true })
  ).toContainText("Claude Code");
  await expect(page.getByText(/Starter includes .* a day/)).toBeVisible();
});

test.describe("coding shortcut routing", () => {
  test.use({
    fakeAudioCaptureFile: path.resolve(__dirname, "../fixtures/dictation/agent-ramble.wav"),
    seedWhisperModels: ["base"],
  });
  test("rewrites once and preserves spoken send with ordinary enhancement enabled", async ({
    controlPanel,
    overlayWindow,
    electronApp,
  }) => {
    await unlockTesterAccess(controlPanel);
    await overlayWindow.evaluate(() => {
      for (const [key, value] of Object.entries({
        useLocalWhisper: "true",
        whisperModel: "base",
        localTranscriptionProvider: "whisper",
        useReasoningModel: "true",
        reasoningModel: "claude-code",
        reasoningProvider: "claude-code",
        codingPromptUseSharedConnection: "true",
        autoPaste: "true",
        copyToClipboard: "false",
        audioFeedback: "false",
        actionEngineEnabled: "false",
      }))
        localStorage.setItem(key, value);
    });
    await electronApp.evaluate(({ ipcMain }) => {
      const state = { transcriptions: 0, rewrites: 0, pastes: [] as any[] };
      (globalThis as any).__enhancementRouting = state;
      ipcMain.removeHandler("transcribe-local-whisper");
      ipcMain.handle("transcribe-local-whisper", () => {
        state.transcriptions++;
        return { success: true, text: "Fix the login button send" };
      });
      ipcMain.removeHandler("enhance-with-claude-code");
      ipcMain.handle("enhance-with-claude-code", (_event, text, prompt) => {
        state.rewrites++;
        if (text.includes("send")) throw new Error("Spoken send reached the model");
        if (!prompt.includes("coding agent")) throw new Error("Wrong writing style");
        return { ok: true, text: "Fix the login button." };
      });
      ipcMain.removeHandler("paste-text");
      ipcMain.handle("paste-text", (_event, text, options) => {
        state.pastes.push({ text, options });
        return { delivered: true, enterSent: options?.sendEnter === true };
      });
    });
    const send = (channel: string) =>
      electronApp.evaluate(({ BrowserWindow }, channel) => {
        BrowserWindow.getAllWindows()
          .find((win) => !win.webContents.getURL().includes("panel=true"))
          ?.webContents.send(channel);
      }, channel);
    await send("start-agent-dictation");
    await expect(overlayWindow.getByText("Coding prompt", { exact: true })).toBeVisible();
    await overlayWindow.waitForTimeout(2000);
    await send("stop-agent-dictation");
    await expect
      .poll(() => electronApp.evaluate(() => (globalThis as any).__enhancementRouting), {
        timeout: 15000,
      })
      .toEqual({
        transcriptions: 1,
        rewrites: 1,
        pastes: [{ text: "Fix the login button.", options: { sendEnter: true } }],
      });
  });
});
