import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("growth analytics funnel wiring", () => {
  it("tracks onboarding progress and completion", () => {
    const onboarding = fs.readFileSync(
      path.join(process.cwd(), "src", "components", "OnboardingFlow.tsx"),
      "utf8"
    );

    expect(onboarding).toContain('"onboarding_step_viewed"');
    expect(onboarding).toContain('"onboarding_completed"');
    expect(onboarding).toContain("trackAnalyticsEventOnce");
  });

  it("tracks recording starts, completions, and the first successful dictation", () => {
    const recordingHook = fs.readFileSync(
      path.join(process.cwd(), "src", "hooks", "useAudioRecording.js"),
      "utf8"
    );

    expect(recordingHook).toContain('"transcription_started"');
    expect(recordingHook).toContain('"transcription_completed"');
    expect(recordingHook).toContain('"first_transcription_completed"');
    expect(recordingHook).toContain("buildTranscriptionAnalyticsProperties");
  });
});
