import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { expect, test } from "./fixtures/electron-app";

const run = promisify(execFile);

test("native Windows ranges match rich text, wraps, bullets and text after code", async ({
  electronApp,
}) => {
  test.skip(process.platform !== "win32");
  const title = `PT native read aloud ${Date.now()}`;
  await electronApp.evaluate(async ({ app, BrowserWindow }, title) => {
    app.setAccessibilitySupportEnabled(true);
    const source = new BrowserWindow({ width: 470, height: 560, show: false });
    (globalThis as any).__nativeReadSource = source;
    await source.loadURL(
      `data:text/html;charset=utf-8,${encodeURIComponent(`
      <title>${title}</title><style>body{font:20px/1.8 system-ui;padding:24px}</style>
      <p>A quiet <strong>morning</strong> makes room for a little reading across several lines.</p>
      <ul><li>A short <em>bullet item</em> with Y=-53 and 30 minutes.</li></ul>
      <pre>const result = { value: 12345678901234567890 };</pre>
      <p>The prose after the code is still readable.</p>
    `)}`
    );
    // The shared harness makes this window transparent and click-through.
    source.showInactive();
  }, title);
  try {
    const sentences = [
      { index: 0, text: "A quiet morning makes room for a little reading across several lines." },
      { index: 1, text: "- A short bullet item with Y=-53 and 30 minutes." },
      { index: 2, text: "The prose after the code is still readable." },
      { index: 0, text: "A quiet morning makes room for a little reading across several lines." },
    ];
    const { stdout } = await run(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-File",
        path.resolve("tests/fixtures/readAloudNativeRanges.ps1"),
        "-CaseJsonBase64",
        Buffer.from(JSON.stringify({ title, sentences })).toString("base64"),
      ],
      { windowsHide: true, timeout: 20000 }
    );
    const results = JSON.parse(Buffer.from(stdout.trim(), "base64").toString("utf8"));
    for (const result of results)
      for (const word of result.words) word.rects = JSON.parse(word.rectsJson || "[]");
    for (let i = 0; i < sentences.length; i++) {
      expect(results[i].matched, JSON.stringify(results[i])).toBe(true);
      // Chromium includes the paragraph newline in its final word range.
      expect(results[i].words.map((word) => word.text.trim()).join(" ")).toBe(
        sentences[i].text.replace(/^- /, "")
      );
      for (const word of results[i].words) {
        expect(word.rects.length, `visible rectangle for ${word.text}`).toBeGreaterThan(0);
        expect(sentences[i].text.slice(word.start, word.start + word.text.trim().length)).toBe(
          word.text.trim()
        );
      }
    }
    expect(
      new Set(results[0].words.flatMap((word) => word.rects.map((rect) => rect.y))).size
    ).toBeGreaterThan(1);
  } finally {
    await electronApp.evaluate(() => (globalThis as any).__nativeReadSource.destroy());
  }
});
