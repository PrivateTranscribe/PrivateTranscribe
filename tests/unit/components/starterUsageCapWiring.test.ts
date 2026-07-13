import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("Starter usage cap wiring", () => {
  it("blocks new free dictation after the daily word limit is reached", () => {
    const hook = fs.readFileSync(
      path.join(process.cwd(), "src", "hooks", "useAudioRecording.js"),
      "utf8"
    );

    expect(hook).toContain("isStarterLimitReached");
    expect(hook).toContain("Starter word limit reached");
    expect(hook).toContain('analyticsTrack?.("starter_limit_hit"');
    expect(hook).toContain("recordStarterUsageIfNeeded(text)");
  });

  it("counts uploaded file transcription words without locking model access", () => {
    const page = fs.readFileSync(
      path.join(process.cwd(), "src", "components", "pages", "TranscribePage.tsx"),
      "utf8"
    );

    expect(page).toContain("recordStarterWords(text)");
    expect(page).toContain('analyticsTrack?.("starter_file_words_used"');
    expect(page).toContain("processFileTranscriptionV2(file, whisperModel");
  });

  it("shows remaining daily words on the dashboard for Starter users only", () => {
    const card = fs.readFileSync(
      path.join(process.cwd(), "src", "components", "ui", "StarterUsageCard.tsx"),
      "utf8"
    );

    // Reads live usage and hides itself for Pro entitlements
    expect(card).toContain("readStarterUsage()");
    expect(card).toContain('getEffectiveEntitlement() === "pro"');
    expect(card).toContain("if (isPro)");
    // Refreshes on cross-window storage changes (dictation happens in the overlay window)
    expect(card).toContain("STARTER_USAGE_KEY");
    expect(card).toContain('addEventListener("storage"');
    expect(card).toContain("formatTimeUntilLocalMidnight");
    expect(card).toContain("resets in");
    expect(card).not.toContain("resets at midnight");

    const dashboard = fs.readFileSync(
      path.join(process.cwd(), "src", "components", "pages", "DashboardPage.tsx"),
      "utf8"
    );
    expect(dashboard).toContain("<StarterUsageCard refreshToken={transcriptionsVersion} />");
  });
});
