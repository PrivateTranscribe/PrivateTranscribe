import { Check, Loader2, Play, Square } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "./button";
import { cn } from "../lib/utils";
import {
  KOKORO_ACCENTS,
  SORTED_KOKORO_VOICES,
  describeVoice,
  findVoice,
  resolveVoiceId,
  type KokoroVoice,
  type KokoroVoiceAccent,
} from "../../models/kokoroVoices";
import { getSharedAudioContext, waitForAudioContextRunning } from "../../utils/sharedAudioContext";

/**
 * The voice picker, shared by every feature that speaks.
 *
 * Read Aloud and Converse each store their own voice, but they choose it the
 * same way, from the same 28 voices, with the same preview mechanics — so this
 * is one component with a storage-agnostic value/onChange pair, not a copy per
 * page. A second copy is where the two would drift.
 *
 * All 28 voices in one scrollable list rather than a dropdown: the choice is
 * made by ear, so the accent, the gender and the preview button all have to be
 * on screen at once, which a select cannot do. The list is capped at roughly
 * six rows so the page keeps its rhythm instead of becoming a wall, and the
 * accent headings stick to the top edge while you scroll, so it is always clear
 * whether you are in the American or the British half.
 *
 * Previews are synthesized here, in the control panel, and played through the
 * shared AudioContext — deliberately NOT through the overlay's players. Routing
 * an audition through the real player would clear its cache, move its position,
 * and put the playback pill on screen for something that is not a read. Decoded
 * previews are cached per voice for the session, so comparing two voices back
 * and forth costs one synthesis each.
 */

/**
 * One short sentence, on purpose. Every preview is a real CPU synthesis on the
 * user's own machine, so the sample has to be long enough to judge a voice by
 * and short enough that trying six of them is not a chore.
 */
const PREVIEW_TEXT = "This is how PrivateTranscribe will read your text aloud.";

/** What the preview button is doing for one voice, right now. */
type PreviewStatus = "idle" | "synthesizing" | "playing";

type PreviewReport = {
  voice: string;
  rms: number;
  seconds: number;
  status: "synthesizing" | "playing" | "done" | "error";
};

type DecodedPreview = { buffer: AudioBuffer; rms: number; seconds: number };

type VoiceRowProps = {
  voice: KokoroVoice;
  selected: boolean;
  previewStatus: PreviewStatus;
  testIdPrefix: string;
  onSelect: (id: string) => void;
  onPreview: (voice: KokoroVoice) => void;
};

/**
 * One voice. Selecting and previewing are separate actions on purpose — hearing
 * a voice should never quietly change what the feature speaks with.
 */
function VoiceRow({
  voice,
  selected,
  previewStatus,
  testIdPrefix,
  onSelect,
  onPreview,
}: VoiceRowProps) {
  const busy = previewStatus === "synthesizing";
  const playing = previewStatus === "playing";

  return (
    <div
      data-testid={`${testIdPrefix}-voice-row`}
      data-voice-id={voice.id}
      data-selected={selected ? "true" : "false"}
      className={cn(
        "flex items-center gap-1 pr-2 transition-colors",
        selected ? "bg-primary/10" : "hover:bg-surface-2/60"
      )}
    >
      <button
        type="button"
        role="radio"
        aria-checked={selected}
        aria-label={describeVoice(voice)}
        onClick={() => onSelect(voice.id)}
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 px-3 py-2.5 text-left outline-none focus-visible:ring-1 focus-visible:ring-primary/40"
      >
        <Check
          size={14}
          aria-hidden
          className={cn("shrink-0", selected ? "text-primary" : "text-transparent")}
        />
        <span
          className={cn(
            "w-20 shrink-0 truncate text-sm",
            selected ? "font-medium text-foreground" : "text-foreground"
          )}
        >
          {voice.name}
        </span>
        {/* Accent lives in the heading above, so the row carries only what the
            heading does not. */}
        <span className="min-w-0 flex-1 truncate text-[12px] text-muted-foreground">
          {voice.gender}
        </span>
      </button>

      <Button
        type="button"
        variant="ghost"
        size="icon"
        data-testid={`${testIdPrefix}-voice-preview-${voice.id}`}
        aria-label={playing ? `Stop the ${voice.name} preview` : `Play a ${voice.name} preview`}
        onClick={() => onPreview(voice)}
        className={cn(
          "size-8 shrink-0",
          // hover:text-primary as well: the cursor is still parked on the
          // button the user just pressed, and the ghost variant's
          // hover:text-foreground would otherwise repaint the active icon white.
          (busy || playing) && "text-primary hover:text-primary"
        )}
      >
        {busy ? (
          <Loader2 size={14} className="animate-spin" aria-hidden />
        ) : playing ? (
          // Tinted rather than stark white: one voice sounding is a state, not
          // an alert, and the colour is what tells you which row it is.
          <Square size={11} className="fill-current" aria-hidden />
        ) : (
          <Play size={14} aria-hidden />
        )}
      </Button>
    </div>
  );
}

/** Sticky accent heading. A direct child of the scroller, so `sticky` works. */
function AccentHeading({ accent, count }: { accent: KokoroVoiceAccent; count: number }) {
  return (
    <div className="sticky top-0 z-10 flex items-baseline gap-2 border-b border-border-subtle/50 bg-surface-1/95 px-3 py-1.5 backdrop-blur-sm">
      <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        {accent}
      </span>
      <span className="text-[11px] text-muted-foreground/60">{count} voices</span>
    </div>
  );
}

export type VoicePickerProps = {
  /** The stored value, in whatever state storage left it; resolved internally. */
  value: string | null | undefined;
  onChange: (id: string) => void;
  /**
   * One sentence saying what this voice is used for, e.g. "The hotkey reads
   * with Lewis, a British male voice." Written by the page, because only the
   * page knows what speaks.
   */
  usage: (voice: KokoroVoice) => string;
  /** Prefixes every data-testid and names the radiogroup: "readaloud", "converse". */
  testIdPrefix: string;
  ariaLabel: string;
};

export function VoicePicker({ value, onChange, usage, testIdPrefix, ariaLabel }: VoicePickerProps) {
  const [previewingId, setPreviewingId] = useState<string | null>(null);
  const [previewStatus, setPreviewStatus] = useState<PreviewStatus>("idle");
  const [previewError, setPreviewError] = useState<string | null>(null);

  const cacheRef = useRef(new Map<string, DecodedPreview>());
  const sourceRef = useRef<AudioBufferSourceNode | null>(null);
  const lastPreviewRef = useRef<PreviewReport | null>(null);
  /** Bumped by every preview action, so a synthesis that lands late is dropped. */
  const generationRef = useRef(0);
  const listRef = useRef<HTMLDivElement>(null);
  const scrolledToSelection = useRef(false);

  // resolveVoiceId already guaranteed this id is in the table; the fallback is
  // only here so the component cannot crash on a future table change.
  const selected = findVoice(resolveVoiceId(value)) ?? SORTED_KOKORO_VOICES[0];

  // A voice chosen from the bottom of the list would otherwise be invisible on
  // the next visit — the list opens at the top and the check mark is 20 rows
  // down. Runs once, on arrival: re-centring after every click would yank the
  // list out from under the pointer.
  useEffect(() => {
    if (scrolledToSelection.current) return;
    const list = listRef.current;
    const row = list?.querySelector<HTMLElement>(`[data-voice-id="${selected.id}"]`);
    if (!list || !row) return;

    scrolledToSelection.current = true;
    // Measured with rects and applied as a delta to scrollTop. offsetTop is
    // relative to the nearest POSITIONED ancestor, which this list is not, so
    // using it here scrolls straight past the row to the end of the list.
    // scrollIntoView is the other trap: it scrolls the page as well.
    const delta = row.getBoundingClientRect().top - list.getBoundingClientRect().top;
    list.scrollTop = Math.max(
      0,
      list.scrollTop + delta - (list.clientHeight - row.offsetHeight) / 2
    );
  }, [selected.id]);

  const stopPlayback = useCallback(() => {
    const source = sourceRef.current;
    sourceRef.current = null;
    if (source) {
      source.onended = null;
      try {
        source.stop();
      } catch {
        // Already ended.
      }
    }
  }, []);

  // Leaving the page mid-preview must not leave audio playing behind it.
  useEffect(() => () => stopPlayback(), [stopPlayback]);

  const playPreview = useCallback(
    async (voice: KokoroVoice) => {
      // A second press on the voice that is already sounding is a stop.
      const alreadySounding = previewingId === voice.id && previewStatus !== "idle";
      const generation = ++generationRef.current;
      stopPlayback();

      if (alreadySounding) {
        setPreviewingId(null);
        setPreviewStatus("idle");
        return;
      }

      setPreviewError(null);
      setPreviewingId(voice.id);

      try {
        let decoded = cacheRef.current.get(voice.id);

        if (!decoded) {
          setPreviewStatus("synthesizing");
          lastPreviewRef.current = { voice: voice.id, rms: 0, seconds: 0, status: "synthesizing" };

          const result = await window.electronAPI?.readAloudSynth?.({
            text: PREVIEW_TEXT,
            voice: voice.id,
          });
          if (generation !== generationRef.current) return;
          if (!result?.pcm) throw new Error("the voice engine returned no audio");

          const ctx = getSharedAudioContext();
          if (!ctx) throw new Error("this window has no audio output");

          const samples =
            result.pcm instanceof Float32Array ? result.pcm : new Float32Array(result.pcm);
          const buffer = ctx.createBuffer(1, samples.length, result.sampleRate);
          buffer.copyToChannel(samples, 0);

          // Measured off the decoded buffer, so "it played" and "it made sound"
          // are two different claims. The e2e asserts on this rather than on a
          // status string, which a silent buffer would also satisfy.
          let sumSquares = 0;
          for (let i = 0; i < samples.length; i++) sumSquares += samples[i] * samples[i];

          decoded = {
            buffer,
            rms: samples.length ? Math.sqrt(sumSquares / samples.length) : 0,
            seconds: samples.length / result.sampleRate,
          };
          cacheRef.current.set(voice.id, decoded);
        }

        const ctx = getSharedAudioContext();
        if (!ctx) throw new Error("this window has no audio output");
        if (ctx.state === "suspended") await waitForAudioContextRunning(ctx);
        if (generation !== generationRef.current) return;

        const source = ctx.createBufferSource();
        source.buffer = decoded.buffer;
        source.connect(ctx.destination);
        source.onended = () => {
          if (generation !== generationRef.current) return;
          sourceRef.current = null;
          setPreviewStatus("idle");
          setPreviewingId(null);
          if (lastPreviewRef.current?.voice === voice.id) {
            lastPreviewRef.current = { ...lastPreviewRef.current, status: "done" };
          }
        };
        source.start();

        sourceRef.current = source;
        setPreviewStatus("playing");
        lastPreviewRef.current = {
          voice: voice.id,
          rms: decoded.rms,
          seconds: decoded.seconds,
          status: "playing",
        };
      } catch (error) {
        if (generation !== generationRef.current) return;
        const detail = error instanceof Error ? error.message : String(error);
        // Inline and quiet: a failed audition is not an app-level event, and a
        // toast would be gone before the user looked back at the list.
        setPreviewError(`Could not preview ${voice.name} - ${detail}.`);
        setPreviewingId(null);
        setPreviewStatus("idle");
        lastPreviewRef.current = { voice: voice.id, rms: 0, seconds: 0, status: "error" };
      }
    },
    [previewingId, previewStatus, stopPlayback]
  );

  // Dev-only handle, behind the same flag as the overlay's. It reports what the
  // decoded buffer actually contained, so the e2e can prove the real play
  // button produced audible PCM for the voice it claims. Only one picker is
  // ever mounted at a time — they live on different pages.
  useEffect(() => {
    if (!window.electronAPI?.readAloudTestEnabled) return;

    (window as unknown as Record<string, unknown>).__voicePickerTest = {
      getLastPreview: () => lastPreviewRef.current,
    };
    return () => {
      delete (window as unknown as Record<string, unknown>).__voicePickerTest;
    };
  }, []);

  return (
    <div data-testid={`${testIdPrefix}-voice-picker`}>
      <div className="flex items-baseline gap-2">
        <p className="text-sm font-medium text-foreground">Voice</p>
        <span className="text-muted-foreground/60" aria-hidden>
          ·
        </span>
        <span data-testid={`${testIdPrefix}-voice-current`} className="text-sm text-foreground">
          {selected.name}
        </span>
      </div>
      <p className="text-[13px] text-muted-foreground mt-1 leading-relaxed">
        {usage(selected)} Previews are synthesized on this machine, so the first one for each voice
        takes a moment.
      </p>

      <div
        ref={listRef}
        role="radiogroup"
        aria-label={ariaLabel}
        data-testid={`${testIdPrefix}-voice-list`}
        className="mt-3 max-h-[17.5rem] overflow-y-auto rounded-lg border border-border-subtle bg-surface-1 divide-y divide-border-subtle/50"
      >
        {/* Flat children rather than a wrapper per accent: the headings can only
            stick to the scroller if the scroller is their offset parent, and the
            rows have to stay direct children for the same measurement to work. */}
        {KOKORO_ACCENTS.map((accent) => {
          const voices = SORTED_KOKORO_VOICES.filter((voice) => voice.accent === accent);
          return [
            <AccentHeading key={`heading-${accent}`} accent={accent} count={voices.length} />,
            ...voices.map((voice) => (
              <VoiceRow
                key={voice.id}
                voice={voice}
                selected={voice.id === selected.id}
                previewStatus={previewingId === voice.id ? previewStatus : "idle"}
                testIdPrefix={testIdPrefix}
                onSelect={onChange}
                onPreview={(v) => void playPreview(v)}
              />
            )),
          ];
        })}
      </div>

      {previewError && (
        <p
          role="status"
          data-testid={`${testIdPrefix}-voice-preview-error`}
          className="mt-2 text-[13px] leading-relaxed text-destructive"
        >
          {previewError}
        </p>
      )}
    </div>
  );
}

export default VoicePicker;
