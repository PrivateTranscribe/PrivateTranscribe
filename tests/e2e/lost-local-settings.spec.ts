import { expect, test } from "./fixtures/electron-app";

/**
 * The control panel keeps its settings in localStorage, which a profile reset
 * or a damaged Local Storage folder can empty. The history limit then read as
 * the default 50 and trimmed the saved history to 50 at once, and the
 * dictionary read as its default and overwrote the saved words on the next edit.
 */
test("settings the window lost neither trim history nor drop the dictionary", async ({
  controlPanel,
}) => {
  await controlPanel.evaluate(async () => {
    const api = (window as any).electronAPI;
    localStorage.setItem("historyLimit", "500");
    await api.setHistoryLimit(500);
    for (let i = 0; i < 60; i += 1) await api.saveTranscription(`Dictation number ${i}`, 2);
    const words = ["PrivateTranscribe", "Kubernetes", "Østerbro"];
    localStorage.setItem("customDictionary", JSON.stringify(words));
    await api.setDictionary(words);
    localStorage.removeItem("historyLimit");
    localStorage.removeItem("customDictionary");
  });
  await controlPanel.reload({ waitUntil: "domcontentloaded" });

  // The window takes the limit the app saved instead of its own default.
  await expect
    .poll(() => controlPanel.evaluate(() => localStorage.getItem("historyLimit")))
    .toBe("500");
  const saved = await controlPanel.evaluate(async () => {
    const rows = await (window as any).electronAPI.getTranscriptions(1000);
    return Array.isArray(rows) ? rows.length : (rows?.data?.length ?? -1);
  });
  expect(saved).toBe(60);

  // The dictionary comes back from the saved copy, so the next edit keeps it.
  await expect
    .poll(() =>
      controlPanel.evaluate(() => JSON.parse(localStorage.getItem("customDictionary") || "[]"))
    )
    .toEqual(["PrivateTranscribe", "Kubernetes", "Østerbro"]);
});

test("an unreadable dictionary entry does not overwrite the saved words", async ({
  controlPanel,
}) => {
  const words = ["PrivateTranscribe", "Kubernetes", "Østerbro"];
  await controlPanel.evaluate(async (list) => {
    localStorage.setItem("customDictionary", JSON.stringify(list));
    await (window as any).electronAPI.setDictionary(list);
    localStorage.setItem("customDictionary", "{not json");
  }, words);
  await controlPanel.reload({ waitUntil: "domcontentloaded" });

  await expect
    .poll(() =>
      controlPanel.evaluate(() => JSON.parse(localStorage.getItem("customDictionary") || "[]"))
    )
    .toEqual(words);
  const saved = await controlPanel.evaluate(() => (window as any).electronAPI.getDictionary());
  expect([...saved].sort()).toEqual([...words].sort());
});
