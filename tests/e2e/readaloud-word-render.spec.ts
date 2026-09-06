import fs from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { expect, test } from "./fixtures/electron-app";

const bulletPreview = process.env.PT_READALOUD_BULLET_PREVIEW === "1";
const evidence = path.resolve(
  bulletPreview ? "docs/qa-readaloud-bullets" : "docs/qa-readaloud-word-follow"
);
const sourceText = "A quiet morning makes room for a little reading.";
const copiedText = `${bulletPreview ? "- " : ""}${sourceText}`;
test.use({ seedKokoroModel: true });

// App-internal visual verification. This exercises the actual highlight
// window over a controlled document, without automating another application.
test("Read Aloud highlight appearance", async ({ electronApp, overlayWindow }) => {
  test.skip(process.platform !== "win32", "The native highlight matcher uses Windows text ranges");
  fs.mkdirSync(evidence, { recursive: true });
  // Exercise the production matcher with clipboard/source differences, then
  // supply controlled screen geometry for those matched ranges.
  const [matched] = JSON.parse(
    execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-File",
        path.resolve("tests/fixtures/readAloudTextRanges.ps1"),
        "-CaseJsonBase64",
        Buffer.from(JSON.stringify([{ document: sourceText, copied: copiedText }])).toString(
          "base64"
        ),
      ],
      { encoding: "utf8", windowsHide: true, timeout: 15000 }
    )
  );
  expect(matched.matched).toBe(true);
  await electronApp.evaluate(
    async (
      { app, BrowserWindow, ipcMain, screen },
      { bulletPreview, sourceText, matchedWords }
    ) => {
      const { createRequire } = (process as any).getBuiltinModule("module");
      const mainRequire = createRequire(`${app.getAppPath()}/main.js`);
      const Highlight = mainRequire("./src/helpers/readAloudHighlight.js");
      const listeners = app.listeners("browser-window-created");
      for (const listener of listeners) app.removeListener("browser-window-created", listener);
      const source = new BrowserWindow({
        x: 100,
        y: 100,
        width: 1000,
        height: 410,
        frame: false,
        show: false,
        webPreferences: { sandbox: true },
      });
      const highlight = new Highlight();
      highlight.ensureWindow();
      for (const listener of listeners) app.on("browser-window-created", listener);
      (globalThis as any).__wordVisual = { source, highlight };
      await source.loadURL(
        `data:text/html;charset=utf-8,${encodeURIComponent(`
      <style>body{margin:0;background:#141815;color:#edf5ef;font:24px/1.9 system-ui}main{padding:48px 64px}h1{font-size:14px;color:#a2b6a8;font-weight:500;letter-spacing:1px;margin:0 0 38px}p{margin:0 0 14px}</style>
      <main><h1>READ ALOUD · HIGHLIGHT PREVIEW</h1>${bulletPreview ? `<ul style="padding-left:26px;margin:0 0 14px"><li id="text">${sourceText}</li><li>Keep your place as the words are spoken.</li></ul>` : `<p id="text">${sourceText}</p><p>Keep your place as the words are spoken.</p>`}<div style="height:900px"></div></main>
    `)}`
      );
      source.showInactive();
      // Controlled document geometry replaces the external UIA transport here.
      // Playback, IPC, scheduling and the highlight window remain production code.
      let target;
      highlight.anchored = true;
      highlight.send = async (command) => {
        if (command.startsWith("locate "))
          target = JSON.parse(Buffer.from(command.slice(7), "base64").toString());
        if (command === "clear" || !target) return "NONE";
        const words = await source.webContents.executeJavaScript(`
        (()=>{const text=document.getElementById('text').firstChild;
        return ${JSON.stringify(matchedWords)}.map(match=>{
          const r=document.createRange();r.setStart(text,match.sourceStart);r.setEnd(text,match.sourceEnd);
          return {start:match.start,rects:Array.from(r.getClientRects(),b=>({x:b.x,y:b.y,w:b.width,h:b.height})).filter(b=>b.y>=0&&b.y+b.h<=innerHeight)};
        });})()
      `);
        const bounds = source.getContentBounds();
        const physical = words.map((word) => ({
          ...word,
          rects: word.rects.map((r) => {
            const b = screen.dipToScreenRect(source, {
              x: bounds.x + r.x,
              y: bounds.y + r.y,
              width: r.w,
              height: r.h,
            });
            return { x: b.x, y: b.y, w: b.width, h: b.height };
          }),
        }));
        return `WORDS ${JSON.stringify(physical)}`;
      };
      ipcMain.removeHandler("readaloud-sentence");
      ipcMain.handle("readaloud-sentence", async (_event, payload) =>
        highlight.onSentence(payload)
      );
    },
    { bulletPreview, sourceText, matchedWords: matched.words }
  );
  try {
    await overlayWindow.evaluate(async (copiedText) => {
      await (window as any).electronAPI.readAloudLoadEngine();
      const player = (window as any).__readAloudTest;
      void player.speak(copiedText);
      await new Promise<void>((resolve, reject) => {
        const deadline = Date.now() + 20000;
        const timer = setInterval(() => {
          if (player.getState().currentWord?.text === "morning") {
            player.pause();
            clearInterval(timer);
            resolve();
          } else if (Date.now() > deadline) {
            clearInterval(timer);
            reject(new Error("Word never reached"));
          }
        }, 10);
      });
    }, copiedText);
    await expect
      .poll(() => electronApp.evaluate(() => (globalThis as any).__wordVisual.highlight.active))
      .toBe(true);
    await expect
      .poll(() =>
        electronApp.evaluate(
          () => (globalThis as any).__wordVisual.highlight.getStatus().target?.start
        )
      )
      .toBe(bulletPreview ? 10 : 8);
    const capture = async (name: string) => {
      // Let the OS compositor finish showing/hiding the transparent window.
      await new Promise((resolve) => setTimeout(resolve, 220));
      const png = await electronApp.evaluate(async ({ desktopCapturer, screen }) => {
        const { source, highlight } = (globalThis as any).__wordVisual;
        await highlight.window.webContents.executeJavaScript(
          "new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))"
        );
        const display = screen.getDisplayMatching(source.getBounds());
        const scale = display.scaleFactor;
        const captureOptions = {
          types: ["screen"] as "screen"[],
          thumbnailSize: {
            width: Math.round(display.size.width * scale),
            height: Math.round(display.size.height * scale),
          },
        };
        // The first desktop thumbnail can be an older compositor frame.
        await desktopCapturer.getSources(captureOptions);
        await new Promise((resolve) => setTimeout(resolve, 100));
        const captures = await desktopCapturer.getSources(captureOptions);
        const bounds = screen.dipToScreenRect(source, source.getContentBounds());
        const origin = screen.dipToScreenPoint({ x: display.bounds.x, y: display.bounds.y });
        return captures
          .find((s) => s.display_id === String(display.id))!
          .thumbnail.crop({
            x: bounds.x - origin.x,
            y: bounds.y - origin.y,
            width: bounds.width,
            height: bounds.height,
          })
          .toPNG()
          .toString("base64");
      });
      fs.writeFileSync(path.join(evidence, name), Buffer.from(png, "base64"));
    };
    await capture("after-word-paused.png");
    const before = await electronApp.evaluate(() =>
      (globalThis as any).__wordVisual.highlight.window.getBounds()
    );
    await electronApp.evaluate(() =>
      (globalThis as any).__wordVisual.source.webContents.executeJavaScript("window.scrollTo(0,60)")
    );
    await expect
      .poll(
        () =>
          electronApp.evaluate(
            () => (globalThis as any).__wordVisual.highlight.window.getBounds().y
          ),
        { intervals: [20], timeout: 1000 }
      )
      .toBe(before.y - 60);
    await capture("after-scroll.png");
    await electronApp.evaluate(() =>
      (globalThis as any).__wordVisual.source.webContents.executeJavaScript(
        "window.scrollTo(0,600)"
      )
    );
    await expect
      .poll(() => electronApp.evaluate(() => (globalThis as any).__wordVisual.highlight.active), {
        intervals: [20],
        timeout: 1000,
      })
      .toBe(false);
    await capture("after-offscreen.png");
    await electronApp.evaluate(() =>
      (globalThis as any).__wordVisual.source.webContents.executeJavaScript("window.scrollTo(0,0)")
    );
    await expect
      .poll(() => electronApp.evaluate(() => (globalThis as any).__wordVisual.highlight.active), {
        intervals: [20],
        timeout: 1000,
      })
      .toBe(true);
    await capture("after-return.png");
    await overlayWindow.evaluate(() => (window as any).__readAloudTest.stop());
    await expect
      .poll(() => electronApp.evaluate(() => (globalThis as any).__wordVisual.highlight.active))
      .toBe(false);
    await capture("after-stopped.png");
  } finally {
    await electronApp.evaluate(() => {
      (globalThis as any).__wordVisual.highlight.stop();
      (globalThis as any).__wordVisual.source.destroy();
    });
  }
});
