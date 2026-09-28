import fs from "node:fs";
import path from "node:path";
import { expect, test } from "./fixtures/electron-app";
import { unlockTesterAccess } from "./fixtures/tester-access";
import { disclosure } from "./fixtures/tab-layout";

const evidence = path.resolve("test-results/ai-enhancement");
const localId = "qwen3.8-2b-distill-q4_k_m";

async function capture(page: import("@playwright/test").Page, name: string) {
  fs.mkdirSync(evidence, { recursive: true });
  await page.screenshot({ path: path.join(evidence, `after-${name}.png`), animations: "disabled" });
}

test.use({
  useThrowawayHome: true,
  appEnv: { PRIVATETRANSCRIBE_DIAG_DISABLE_OVERLAY_WINDOW: "1" },
});

test("cloud cleanup shows result, timing, errors and preserves its custom prompt", async ({
  controlPanel: page,
  electronApp,
}) => {
  await electronApp.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler("get-openai-key");
    ipcMain.handle("get-openai-key", () => "e2e-fake-key");
  });
  // First: turning beta features on reloads the window, which would drop the fetch stub below.
  await unlockTesterAccess(page);
  await page.evaluate(() => {
    localStorage.setItem("useReasoningModel", "true");
    localStorage.setItem("reasoningModel", "gpt-5.6-luna");
    localStorage.setItem("openaiApiKey", "e2e-fake-key");
    localStorage.setItem(
      "customUnifiedPrompt",
      JSON.stringify("Preserve all names. You are {{agentName}}.")
    );
    (window as any).__cleanupRequests = [];
    const fetchOriginal = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      if (String(input).startsWith("https://api.openai.com/v1/")) {
        const body = JSON.parse(String(init?.body || "{}"));
        (window as any).__cleanupRequests.push(body);
        await new Promise((resolve) => setTimeout(resolve, 250));
        if ((window as any).__cleanupFail)
          return new Response(JSON.stringify({ error: { message: "API key rejected" } }), {
            status: 401,
          });
        return new Response(
          JSON.stringify({
            output_text: "Send the draft on Thursday and keep the budget at fifty kroner.",
          }),
          { status: 200 }
        );
      }
      return fetchOriginal(input, init);
    };
  });
  await page.getByRole("button", { name: "AI Enhancement", exact: true }).click();
  await expect(page.getByText("GPT-5.6 Luna", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("API key saved", { exact: true }).first()).toBeVisible();
  await capture(page, "cloud-ready");
  await page.getByRole("button", { name: "Try cleanup", exact: true }).click();
  await expect(page.getByTestId("cleanup-result")).toContainText("Thursday");
  await expect(page.getByText(/GPT-5.6 Luna · \d+\.\d{2} s/)).toBeVisible();
  const requests = await page.evaluate(() => (window as any).__cleanupRequests);
  expect(requests).toHaveLength(1);
  expect(requests[0].model).toBe("gpt-5.6-luna");
  expect(requests[0].reasoning).toEqual({ effort: "none" });
  expect(requests[0].input[0].content).toContain("Preserve all names");
  await capture(page, "cleanup-result");
  await page.getByRole("textbox", { name: "Text to clean up" }).fill("");
  await expect(page.getByRole("button", { name: "Try cleanup", exact: true })).toBeDisabled();
  await expect(page.getByTestId("cleanup-result")).toHaveCount(0);
  await capture(page, "empty-input");
  await page.getByRole("textbox", { name: "Text to clean up" }).fill("A new sample");
  await page.evaluate(() => {
    (window as any).__cleanupFail = true;
  });
  await page.getByRole("button", { name: "Try cleanup", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText(/key|401/i);
  await capture(page, "cleanup-error");
  await disclosure(page, "Change model or provider").click();
  await page.getByRole("combobox", { name: "Cloud cleanup model" }).click();
  await expect(page.getByRole("option", { name: "GPT-5.6 Terra" })).toBeVisible();
  await capture(page, "cloud-models-open");
  await page.keyboard.press("Escape");
});

test("local setup downloads the suggested model, tests it and keeps alternatives available", async ({
  controlPanel: page,
  electronApp,
}) => {
  await electronApp.evaluate(({ ipcMain }, modelId) => {
    let downloaded = false;
    ipcMain.removeHandler("model-get-all");
    ipcMain.handle("model-get-all", () => [{ id: modelId, isDownloaded: downloaded }]);
    ipcMain.removeHandler("model-download");
    ipcMain.handle("model-download", async (event, id) => {
      if (id !== modelId) throw new Error("Unexpected model");
      event.sender.send("model-download-progress", {
        modelId: id,
        progress: 50,
        downloadedSize: 656082112,
        totalSize: 1312164224,
      });
      await new Promise((resolve) => setTimeout(resolve, 700));
      downloaded = true;
      return { success: true };
    });
    ipcMain.removeHandler("process-local-reasoning");
    ipcMain.handle("process-local-reasoning", (_event, text, id, _name, config) => {
      if (id !== modelId || !config.customSystemPrompt?.includes("FAITHFUL CLEANUP"))
        throw new Error("Missing cleanup prompt");
      return { success: true, text: "Send the draft on Thursday." };
    });
  }, localId);
  await unlockTesterAccess(page);
  await page.getByRole("button", { name: "AI Enhancement", exact: true }).click();
  await page.getByRole("button", { name: "Enable AI enhancement" }).click();
  await page.getByRole("combobox", { name: "Enhance using", exact: true }).click();
  await page.getByRole("option", { name: "Local model", exact: true }).click();
  await expect(page.getByRole("button", { name: "Try cleanup", exact: true })).toBeDisabled();
  await capture(page, "local-download");
  await page.getByRole("button", { name: "Download", exact: true }).click();
  await expect(page.getByRole("button", { name: "Try cleanup", exact: true })).toBeEnabled();
  expect(await page.evaluate(() => localStorage.getItem("reasoningModel"))).toBe(localId);
  await capture(page, "local-ready");
  await page.getByRole("button", { name: "Try cleanup", exact: true }).click();
  await expect(page.getByTestId("cleanup-result")).toHaveText("Send the draft on Thursday.");
  await capture(page, "local-result");
  await page.getByRole("button", { name: "Choose another local model" }).click();
  await expect(page.getByText("Qwen3 8B", { exact: true })).toBeVisible();
  await capture(page, "local-models-open");
  await page.getByRole("button", { name: "Show selected model" }).click();
  await expect(page.getByText("Qwen3 8B", { exact: true })).toBeHidden();
  await electronApp.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()
      .find((win) => win.webContents.getURL().includes("panel=true"))
      ?.setSize(960, 760);
  });
  await capture(page, "local-small-window");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true
  );
});
