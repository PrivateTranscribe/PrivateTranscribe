import { useState } from "react";
import { Gauge } from "lucide-react";
import { Button } from "./ui/button";
import { IconTile } from "./ui/IconTile";
import { useParakeetSetup, PARAKEET_OFFER_DISMISSED_KEY } from "../hooks/useParakeetSetup";
import { PARAKEET_DOWNLOAD_MB, recommendsParakeet } from "../utils/parakeetLanguages";
import type { LocalTranscriptionProvider } from "../types/electron";

interface ParakeetOfferCardProps {
  useLocalWhisper: boolean;
  localTranscriptionProvider: LocalTranscriptionProvider;
  whisperModel: string;
  spokenLanguages: string[];
  onEngineChange: (change: {
    localTranscriptionProvider: LocalTranscriptionProvider;
    whisperModel?: string;
  }) => void;
}

function readDismissed(): boolean {
  try {
    return localStorage.getItem(PARAKEET_OFFER_DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * One-time offer for an existing Whisper user whose PC has no NVIDIA GPU, or
 * one too small for Turbo, and passes Parakeet's hardware and language checks.
 */
export default function ParakeetOfferCard({
  useLocalWhisper,
  localTranscriptionProvider,
  whisperModel,
  spokenLanguages,
  onEngineChange,
}: ParakeetOfferCardProps) {
  const [dismissed, setDismissed] = useState(readDismissed);
  const parakeet = useParakeetSetup({
    spokenLanguages,
    localTranscriptionProvider,
    applyEngine: onEngineChange,
  });

  // A failed speed test already answered the question for this PC.
  const testedAndFailed = parakeet.lastResult?.passed === false || parakeet.fellBackToWhisper;
  const visible =
    !dismissed &&
    useLocalWhisper &&
    localTranscriptionProvider === "whisper" &&
    !testedAndFailed &&
    recommendsParakeet(parakeet.fit, whisperModel);
  if (!visible) return null;

  const dismiss = () => {
    try {
      localStorage.setItem(PARAKEET_OFFER_DISMISSED_KEY, "1");
    } catch {
      // Hidden for this session only.
    }
    setDismissed(true);
  };

  return (
    <div
      className="flex items-start gap-3 rounded-lg border border-primary/25 bg-primary/5 p-3"
      data-testid="parakeet-offer"
    >
      <IconTile size="md">
        <Gauge className="w-4 h-4 text-primary" />
      </IconTile>
      <div className="min-w-0 flex-1 space-y-2">
        <div className="space-y-0.5">
          <p className="text-sm font-medium text-foreground">Try Parakeet on this PC</p>
          <p className="text-xs leading-relaxed text-muted-foreground">
            {parakeet.fit?.isCudaPc
              ? "Your graphics card only has room for a small Whisper model. Parakeet runs on the processor instead and makes fewer mistakes,"
              : "On a PC without an NVIDIA graphics card, Parakeet transcribes about twice as fast as Whisper Base with fewer mistakes,"}{" "}
            and it covers the languages you speak. It is a {PARAKEET_DOWNLOAD_MB} MB download
            followed by a short speed test. If your PC is too slow for it, you stay on Whisper.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            size="sm"
            className="h-7 px-3 text-xs"
            onClick={() => void parakeet.tryParakeet()}
          >
            Try Parakeet
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-7 px-3 text-xs text-muted-foreground"
            onClick={dismiss}
          >
            Not now
          </Button>
        </div>
      </div>
    </div>
  );
}
