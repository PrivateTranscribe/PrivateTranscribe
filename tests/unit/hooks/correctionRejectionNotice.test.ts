import { describe, expect, test } from "vitest";
import { getCorrectionRejectionNotice } from "../../../src/hooks/useAudioRecording";
import {
  CORRECTION_REJECTION_REASONS,
  explainCorrectionRejection,
} from "../../../src/utils/tokenSnapper";

/**
 * Auto-learn used to fail silently: the user corrected a word, the guards rejected
 * the edit, and nothing appeared. The fix is one toast for the near-miss only.
 * Everything else has to stay quiet, because the clipboard gets used for unrelated
 * things during the 30s poll window and a toast on every copy is worse than silence.
 */
describe("getCorrectionRejectionNotice", () => {
  test("answers the near-miss where the edit changed the word count", () => {
    const notice = getCorrectionRejectionNotice(CORRECTION_REJECTION_REASONS.TOKEN_COUNT_CHANGED);
    expect(notice).not.toBeNull();
    expect(notice?.title).toBe("Couldn't learn that correction");
    // The copy has to name the real setting and the real place it lives, or it is
    // just another dead end for the user.
    expect(notice?.description).toContain("Learn phrase and sentence rewrites");
    expect(notice?.description).toContain("Correction Memory");
    expect(notice?.description).toContain("Dictionary");
  });

  test("stays silent for ordinary clipboard use", () => {
    // Copying something unrelated, or clearing the field, is not a correction attempt.
    expect(getCorrectionRejectionNotice(CORRECTION_REJECTION_REASONS.TOO_DIFFERENT)).toBeNull();
    expect(getCorrectionRejectionNotice(CORRECTION_REJECTION_REASONS.MOSTLY_DELETED)).toBeNull();
  });

  test("stays silent when there is nothing to suggest", () => {
    // Phrase learning is already on, so the toast would have no next step to offer.
    expect(getCorrectionRejectionNotice(CORRECTION_REJECTION_REASONS.NO_LEARNABLE_SPAN)).toBeNull();
    expect(getCorrectionRejectionNotice(CORRECTION_REJECTION_REASONS.TOO_LONG)).toBeNull();
    expect(getCorrectionRejectionNotice(CORRECTION_REJECTION_REASONS.NO_CHANGE)).toBeNull();
  });

  test("stays silent when the correction was learnable", () => {
    // null reason means pairs were produced, and the Learn toast covers that path.
    expect(getCorrectionRejectionNotice(null)).toBeNull();
    expect(getCorrectionRejectionNotice(undefined)).toBeNull();
  });

  test("a reason it does not know about defaults to silence", () => {
    expect(getCorrectionRejectionNotice("something-new")).toBeNull();
  });

  test("fires for the word-count near-miss end to end", () => {
    // The two halves wired together the way the hook wires them.
    const notice = getCorrectionRejectionNotice(
      explainCorrectionRejection("call me at noon", "call me at noon today")
    );
    expect(notice?.title).toBe("Couldn't learn that correction");
  });

  test("says nothing when the user copies something unrelated", () => {
    expect(
      getCorrectionRejectionNotice(
        explainCorrectionRejection("call me at noon", "https://example.com/some/link")
      )
    ).toBeNull();
  });
});
