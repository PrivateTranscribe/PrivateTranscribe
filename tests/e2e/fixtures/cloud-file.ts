import type { Page, ElectronApplication } from "@playwright/test";

export async function cloudFile(page: Page, app: ElectronApplication) {
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler("get-openai-key");
    ipcMain.handle("get-openai-key", () => "sk-e2e-offline-test");
  });
  await page.evaluate(() => {
    localStorage.setItem("useLocalWhisper", "false");
    localStorage.setItem("cloudTranscriptionProvider", "openai");
    localStorage.setItem("cloudTranscriptionModel", "whisper-1");
    localStorage.setItem("preferredLanguage", "da");
    localStorage.setItem("fileTranscriptionLanguage", "sv");
    localStorage.setItem("fileTranscriptionSpeakerDetection", "true");
    localStorage.setItem("allowLocalFallback", "false");
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.evaluate(() => {
    const realFetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      if (String(input).includes("/audio/transcriptions")) {
        (window as any).__sentLanguage = (init?.body as FormData).get("language");
        (window as any).__cloudAborted = false;
        return new Promise<Response>((resolve, reject) => {
          (window as any).__finishTranscription = (text: string) =>
            resolve(
              new Response(JSON.stringify({ text }), {
                status: 200,
                headers: { "Content-Type": "application/json" },
              })
            );
          init?.signal?.addEventListener(
            "abort",
            () => {
              (window as any).__cloudAborted = true;
              reject(new DOMException("Cancelled", "AbortError"));
            },
            { once: true }
          );
        });
      }
      return realFetch(input, init);
    };
  });
  await page.getByRole("button", { name: "Transcribe File", exact: true }).click();
}
