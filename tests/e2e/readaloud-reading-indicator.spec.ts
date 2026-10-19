import fs from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures/electron-app";
import { evidenceDir } from "./fixtures/evidence";

/**
 * The dictation button shows Read Aloud's voice the way it shows yours. While
 * dictating, dark bars on the mint disc move with the microphone; while a read
 * plays, mint bars on the dark disc move with the audio being spoken. The disc
 * never turns mint for a read, because mint means the microphone is live.
 * Paused, the bars hold still; stopped, the button rests as the line again.
 *
 * PT_READING_INDICATOR_BEFORE=1 captures the look this replaced and skips the
 * assertions only the new button meets. PT_READING_INDICATOR_FRAMES=1 also
 * saves three seconds of frames while it reads, for judging the motion.
 * Captures are painted over a flat grey backdrop, because the overlay window
 * itself is transparent.
 */
const before = process.env.PT_READING_INDICATOR_BEFORE === "1";
const frames = process.env.PT_READING_INDICATOR_FRAMES === "1";
const evidence = evidenceDir("qa-readaloud-reading-indicator");
test.use({ seedKokoroModel: true });

const BACKDROP = "#3b3f46";
/** The shell's idle fill. The recording mint must never appear during a read. */
const IDLE_SHELL_FILL = "rgba(8, 9, 8, 0.72)";

/** The vertical scale of each reading bar, from its inline transform. */
async function barScales(overlay: Page): Promise<number[]> {
  return overlay.getByTestId("overlay-readaloud-bars").evaluate((el) =>
    Array.from(el.children).map((bar) => {
      const match = /scaleY\(([\d.]+)\)/.exec((bar as HTMLElement).style.transform);
      return match ? Number(match[1]) : Number.NaN;
    })
  );
}

test("the dictation button shows the voice Read Aloud is speaking", async ({ overlayWindow }) => {
  test.setTimeout(120_000);
  fs.mkdirSync(evidence, { recursive: true });

  const button = overlayWindow.getByRole("button", { name: "Dictation overlay" });
  const player = overlayWindow.getByTestId("readaloud-overlay-player");
  const bars = overlayWindow.getByTestId("overlay-readaloud-bars");

  // A backdrop element rather than a page background: index.css keeps the
  // overlay's html and body transparent with a layered !important rule.
  await overlayWindow.evaluate((color) => {
    const backdrop = document.createElement("div");
    backdrop.style.cssText = `position:fixed;inset:0;z-index:-1;background:${color}`;
    document.body.prepend(backdrop);
  }, BACKDROP);
  // Captured at 3x so a 44px button can be judged; the clip's scale re-renders
  // the page rather than enlarging a 1x bitmap.
  const cdp = await overlayWindow.context().newCDPSession(overlayWindow);

  const capture = async (state: string, file = `${before ? "before" : "after"}-${state}.png`) => {
    const boxes = [await button.boundingBox()];
    if (await player.count()) boxes.push(await player.boundingBox());
    const present = boxes.filter((box): box is NonNullable<typeof box> => Boolean(box));
    const pad = 24;
    const left = Math.min(...present.map((b) => b.x)) - pad;
    const top = Math.min(...present.map((b) => b.y)) - pad;
    const right = Math.max(...present.map((b) => b.x + b.width)) + pad;
    const bottom = Math.max(...present.map((b) => b.y + b.height)) + pad;
    const { data } = await cdp.send("Page.captureScreenshot", {
      format: "png",
      clip: { x: left, y: top, width: right - left, height: bottom - top, scale: 3 },
    });
    fs.writeFileSync(path.join(evidence, file), Buffer.from(data, "base64"));
  };

  await capture("idle");

  await overlayWindow.evaluate(async () => {
    await (window as any).electronAPI.readAloudLoadEngine();
    void (window as any).__readAloudTest.speak(
      "A quiet morning makes room for a little reading. Keep your place as the words are spoken, one sentence at a time. The read goes on long enough to pause it halfway."
    );
  });
  await expect(player.getByRole("button", { name: "Pause reading" })).toBeVisible({
    timeout: 30_000,
  });

  // Sample the bars through a second and a half of speech.
  const seen = new Set<string>();
  let peak = 0;
  if (!before) {
    await expect(bars).toBeVisible();
    // Mint bars on the dark disc: the microphone is not live.
    await expect(button.locator(".overlay-shell")).toHaveCSS("background-color", IDLE_SHELL_FILL);
    for (let i = 0; i < 30; i++) {
      const scales = await barScales(overlayWindow);
      seen.add(scales.map((s) => s.toFixed(3)).join(","));
      peak = Math.max(peak, scales[2]);
      await overlayWindow.waitForTimeout(50);
    }
    expect(seen.size, "the bars move with the voice").toBeGreaterThan(5);
  }
  await capture("playing");
  if (frames) {
    const dir = path.join(evidence, `${before ? "before" : "after"}-frames`);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    const started = Date.now();
    for (let i = 0; Date.now() - started < 3_000; i++) {
      await capture("frame", path.join(path.basename(dir), `${String(i).padStart(3, "0")}.png`));
    }
  }

  await player.getByRole("button", { name: "Pause reading" }).click();
  await expect(player).toContainText("Paused");
  if (!before) {
    // Nothing is being said, so the bars settle and then hold still.
    let settled = "";
    await expect
      .poll(
        async () => {
          const first = (await barScales(overlayWindow)).join(",");
          await overlayWindow.waitForTimeout(300);
          const second = (await barScales(overlayWindow)).join(",");
          settled = second;
          return first === second;
        },
        { message: "paused bars hold still", timeout: 5_000 }
      )
      .toBe(true);
    const rest = settled.split(",").map(Number);
    expect(peak, "speech lifts the centre bar above where it rests").toBeGreaterThan(
      rest[2] + 0.15
    );
  }
  await overlayWindow.mouse.move(0, 0);
  await capture("paused");

  await player.getByRole("button", { name: "Stop reading" }).click();
  await expect(player).toHaveCount(0);
  if (!before) await expect(bars).toHaveCount(0);
  await capture("stopped");
});
