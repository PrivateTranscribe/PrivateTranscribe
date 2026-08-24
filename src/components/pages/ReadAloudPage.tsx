import { AudioLines, Check, Download, Loader2, Lock, Play, Square } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "../ui/button";
import { Toggle } from "../ui/toggle";
import { Badge } from "../ui/badge";
import { HotkeyInput } from "../ui/HotkeyInput";
import { InfoBox } from "../ui/InfoBox";
import { SettingsRow } from "../ui/SettingsSection";
import { DownloadProgressBar } from "../ui/DownloadProgressBar";
import { BetaBadge } from "../ui/BetaBadge";
import { BetaAccessLink } from "../ui/BetaAccessLink";
import { cn } from "../lib/utils";
import { useModelDownload } from "../../hooks/useModelDownload";
import { useSettings } from "../../hooks/useSettings";
import { isFeatureUnlocked } from "../../hooks/useProStatus";
import { DEFAULT_READ_ALOUD_HOTKEY } from "../../utils/hotkeys";
import {
  DEFAULT_KOKORO_VOICE_ID,
  SORTED_KOKORO_VOICES,
  findVoice,
  resolveVoiceId,
  type KokoroVoice,
} from "../../models/kokoroVoices";
import { getSharedAudioContext, waitForAudioContextRunning } from "../../utils/sharedAudioContext";
import type { KokoroModelStatus } from "../../types/electron";

/** The one Kokoro model in the registry. */
const READ_ALOUD_MODEL_ID = "kokoro-82m-v1.0-fp32";
const READ_ALOUD_MODEL_LABEL = "Kokoro 82M";
/** Registry total, stated up front so the download is never a surprise. */
const READ_ALOUD_DOWNLOAD_LABEL = "326 MB";

/**
 * One short sentence, on purpose. Every preview is a real CPU synthesis on the
 * user's own machine, so the sample has to be long enough to judge a voice by
 * and short enough that trying six of them is not a chore.
 */
const PREVIEW_TEXT = "This is how PrivateTranscribe will read your text aloud.";

/** Matches the panel treatment the other control-panel pages use. */
function Panel({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-xl border border-border-subtle/50 bg-surface-raised/50 divide-y divide-border-subtle/30 shadow-sm overflow-hidden">
      {children}
    </div>
  );
}

function PanelRow({ children }: { children: ReactNode }) {
  return <div className="px-5 py-4">{children}</div>;
}

/**
 * Said in every unlocked state, because the limit is not a footnote.
 *
 * The model itself ships 54 voices in nine languages. The phonemizer bundled
 * with it does not - it only knows English, and rejects every other language
 * id before synthesis starts. So the honest sentence is about the pronunciation
 * engine, not about the voices, and it promises nothing about other languages
 * arriving.
 */
function EnglishOnlyNotice() {
  return (
    <InfoBox variant="muted" className="text-[13px] leading-relaxed text-muted-foreground">
      <span className="font-medium text-foreground">English only.</span> All 28 voices are English.
      The pronunciation engine that ships with the model knows no other language, so Danish and
      other non-English text comes out mispronounced.
    </InfoBox>
  );
}

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
  isDefault: boolean;
  previewStatus: PreviewStatus;
  onSelect: (id: string) => void;
  onPreview: (voice: KokoroVoice) => void;
};

/**
 * One voice. Selecting and previewing are separate actions on purpose - hearing
 * a voice should never quietly change what the hotkey reads with.
 */
function VoiceRow({
  voice,
  selected,
  isDefault,
  previewStatus,
  onSelect,
  onPreview,
}: VoiceRowProps) {
  const busy = previewStatus === "synthesizing";
  const playing = previewStatus === "playing";

  return (
    <div
      data-testid="readaloud-voice-row"
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
        aria-label={`${voice.name}, ${voice.accent} ${voice.gender}, grade ${voice.grade}`}
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
        <span className="min-w-0 flex-1 truncate text-[12px] text-muted-foreground">
          {voice.accent} · {voice.gender}
          {isDefault && !selected && <span className="ml-2 opacity-70">Default</span>}
        </span>
        <Badge
          variant="outline"
          aria-hidden
          className="w-9 shrink-0 justify-center px-0 font-mono text-[11px]"
        >
          {voice.grade}
        </Badge>
      </button>

      <Button
        type="button"
        variant="ghost"
        size="icon"
        data-testid={`readaloud-voice-preview-${voice.id}`}
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

/**
 * The voice picker.
 *
 * All 28 voices in one scrollable list rather than a dropdown: the choice is
 * made by ear, so the grade, the accent and the preview button all have to be
 * on screen at once, which a select cannot do. The list is capped at roughly
 * six rows so the page keeps its rhythm instead of becoming a wall.
 *
 * Previews are synthesized here, in the control panel, and played through the
 * shared AudioContext - deliberately NOT through the overlay's ReadAloudPlayer.
 * Routing an audition through the real player would clear its cache, move its
 * position, and put the playback pill on screen for something that is not a
 * read. Decoded previews are cached per voice for the session, so comparing two
 * voices back and forth costs one synthesis each.
 */
function VoicePicker({
  selectedVoiceId,
  onSelect,
}: {
  selectedVoiceId: string;
  onSelect: (id: string) => void;
}) {
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
  const selected = findVoice(selectedVoiceId) ?? SORTED_KOKORO_VOICES[0];

  // A voice chosen from the bottom of the list would otherwise be invisible on
  // the next visit - the list opens at the top and the check mark is 20 rows
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
  // button produced audible PCM for the voice it claims.
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
    <div data-testid="readaloud-voice-picker">
      <div className="flex items-baseline gap-2">
        <p className="text-sm font-medium text-foreground">Voice</p>
        <span className="text-muted-foreground/60" aria-hidden>
          ·
        </span>
        <span data-testid="readaloud-voice-current" className="text-sm text-foreground">
          {selected.name}
        </span>
      </div>
      <p className="text-[13px] text-muted-foreground mt-1 leading-relaxed">
        The hotkey reads with {selected.name}, {selected.accent === "American" ? "an" : "a"}{" "}
        {selected.accent} {selected.gender.toLowerCase()} voice. Grades are the voice author&apos;s
        own listening scores, best first. Previews are synthesized on this machine, so the first one
        for each voice takes a moment.
      </p>

      <div
        ref={listRef}
        role="radiogroup"
        aria-label="Read Aloud voice"
        data-testid="readaloud-voice-list"
        className="mt-3 max-h-[17.5rem] overflow-y-auto rounded-lg border border-border-subtle bg-surface-1 divide-y divide-border-subtle/50"
      >
        {SORTED_KOKORO_VOICES.map((voice) => (
          <VoiceRow
            key={voice.id}
            voice={voice}
            selected={voice.id === selected.id}
            isDefault={voice.id === DEFAULT_KOKORO_VOICE_ID}
            previewStatus={previewingId === voice.id ? previewStatus : "idle"}
            onSelect={onSelect}
            onPreview={(v) => void playPreview(v)}
          />
        ))}
      </div>

      {previewError && (
        <p
          role="status"
          data-testid="readaloud-voice-preview-error"
          className="mt-2 text-[13px] leading-relaxed text-destructive"
        >
          {previewError}
        </p>
      )}
    </div>
  );
}

/**
 * Read Aloud: the voice model, the global shortcut, the voice, and the honest
 * limits of all three.
 *
 * This used to be a tab inside Settings, where nobody found it. It is a sidebar
 * page now for the same reason every other beta workflow is one — the controls
 * and the storage keys are unchanged, only where they live.
 *
 * Every state this page can be in is a state the user can be stuck in, so each
 * one says what is true right now and what the next action is: not checked yet,
 * model missing, downloading, or ready. The model is never fetched without a
 * click — a 326MB background download on a privacy tool would be exactly the
 * kind of surprise this product exists to avoid.
 */
export default function ReadAloudPage() {
  const isUnlocked = isFeatureUnlocked("read-aloud");
  const {
    readAloudEnabled,
    setReadAloudEnabled,
    readAloudHotkey,
    setReadAloudHotkey,
    readAloudVoice,
    setReadAloudVoice,
    // Only read, to refuse a key one of these already owns.
    dictationKey,
    voiceCallMuteKey,
  } = useSettings();

  const [modelStatus, setModelStatus] = useState<KokoroModelStatus | null>(null);
  const [statusChecked, setStatusChecked] = useState(false);

  const refreshModelStatus = useCallback(async () => {
    try {
      const status = await window.electronAPI?.readAloudCheckModelStatus?.(READ_ALOUD_MODEL_ID);
      if (status) setModelStatus(status);
    } catch {
      // A failed status read means "not installed" as far as this screen is
      // concerned; the download button stays the next action either way.
      setModelStatus(null);
    } finally {
      setStatusChecked(true);
    }
  }, []);

  const {
    downloadProgress,
    isDownloading,
    isInstalling,
    isCancelling,
    downloadModel,
    deleteModel,
    cancelDownload,
  } = useModelDownload({
    modelType: "kokoro",
    onDownloadComplete: refreshModelStatus,
  });

  useEffect(() => {
    if (!isUnlocked) return;
    void refreshModelStatus();
  }, [isUnlocked, refreshModelStatus]);

  const installed = Boolean(modelStatus?.installed);

  // The main process owns the global shortcut and refuses to bind it while the
  // model is missing, so every input to that decision re-syncs here.
  useEffect(() => {
    if (!isUnlocked) return;
    void window.electronAPI?.readAloudSyncHotkey?.({
      enabled: readAloudEnabled && installed,
      hotkey: readAloudHotkey,
    });
  }, [isUnlocked, readAloudEnabled, installed, readAloudHotkey]);

  const modelDescription = () => {
    if (isDownloading) {
      return "Downloading from Hugging Face. Nothing is spoken until it finishes.";
    }
    if (!statusChecked) {
      return "Checking this machine for the voice model.";
    }
    if (installed) {
      // Decimal MB, rounded — the download button says "326 MB", and the same
      // file must not appear to change size once it lands on disk.
      const mb = Math.round((modelStatus?.totalBytes ?? 0) / 1e6);
      return `${READ_ALOUD_MODEL_LABEL}, ${mb} MB on this machine. Runs on your CPU, offline.`;
    }
    return `${READ_ALOUD_MODEL_LABEL} is not on this machine. One ${READ_ALOUD_DOWNLOAD_LABEL} download, then Read Aloud works offline.`;
  };

  return (
    <div className="p-8 max-w-4xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-start gap-3 mb-2">
        <AudioLines size={28} className="text-primary mt-0.5 shrink-0" />
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-3xl font-semibold text-foreground tracking-tight">Read Aloud</h1>
            <BetaBadge locked={!isUnlocked} />
          </div>
          <p className="text-sm text-muted-foreground mt-1">
            Select text in any app, press the Read Aloud hotkey, and PrivateTranscribe speaks it
            back. The voice runs on this machine, so the text never leaves your PC.
          </p>
        </div>
      </div>

      {!isUnlocked ? (
        <>
          <div className="rounded-xl border border-primary/20 bg-primary/5 p-6 text-center space-y-3">
            <Lock size={24} className="mx-auto text-primary/60" />
            <h3 className="text-base font-semibold text-foreground">Hear it instead of reading</h3>
            <p className="text-sm text-muted-foreground max-w-md mx-auto leading-relaxed">
              Select a paragraph anywhere - a long email, a PR description, a page of docs - press
              the hotkey, and it is read back to you while you keep working. The voice is an 82M
              model on your own CPU, so nothing you select is sent anywhere. This beta requires
              approved tester access while it is still being built.
            </p>
            <BetaAccessLink className="text-sm" />
          </div>

          <Panel>
            <PanelRow>
              <SettingsRow
                label="Read the selected text out loud"
                badge={<BetaBadge locked />}
                description="Nothing is downloaded and nothing is spoken until it is unlocked."
              >
                <Toggle checked={false} onChange={() => {}} disabled />
              </SettingsRow>
            </PanelRow>
            <PanelRow>
              <EnglishOnlyNotice />
            </PanelRow>
          </Panel>
        </>
      ) : (
        <>
          <Panel>
            <PanelRow>
              <SettingsRow
                label="Voice model"
                description={<span data-testid="readaloud-model-status">{modelDescription()}</span>}
              >
                {isDownloading ? (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={isCancelling}
                    onClick={() => void cancelDownload()}
                  >
                    {isCancelling ? "Cancelling" : "Cancel download"}
                  </Button>
                ) : installed ? (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void deleteModel(READ_ALOUD_MODEL_ID, refreshModelStatus)}
                  >
                    Delete model
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    disabled={!statusChecked}
                    onClick={() => void downloadModel(READ_ALOUD_MODEL_ID)}
                  >
                    <Download size={14} aria-hidden />
                    Download voice model ({READ_ALOUD_DOWNLOAD_LABEL})
                  </Button>
                )}
              </SettingsRow>
            </PanelRow>

            {isDownloading && (
              <div data-testid="readaloud-download-progress">
                <DownloadProgressBar
                  modelName={READ_ALOUD_MODEL_LABEL}
                  progress={downloadProgress}
                  isInstalling={isInstalling}
                />
              </div>
            )}

            <PanelRow>
              <EnglishOnlyNotice />
            </PanelRow>
          </Panel>

          <Panel>
            <PanelRow>
              <SettingsRow
                label="Read the selected text out loud"
                description={
                  installed
                    ? "Binds the hotkey below across every app. Playback controls appear on the dictation overlay while it reads."
                    : "Available once the voice model is on this machine."
                }
              >
                <Toggle
                  checked={readAloudEnabled}
                  onChange={setReadAloudEnabled}
                  disabled={!installed}
                />
              </SettingsRow>
            </PanelRow>
            <PanelRow>
              <SettingsRow
                label="Read Aloud hotkey"
                description={
                  installed
                    ? "Press this while text is selected in any app to start reading it."
                    : "Available once the voice model is on this machine."
                }
              >
                <HotkeyInput
                  value={readAloudHotkey}
                  onChange={setReadAloudHotkey}
                  disabled={!installed}
                  appliesToDictationHotkey={false}
                  ariaLabel="Read Aloud hotkey"
                  conflicts={[
                    { label: "Dictation", hotkey: dictationKey },
                    { label: "Mute my voice call", hotkey: voiceCallMuteKey },
                  ]}
                  onClear={() => setReadAloudHotkey(DEFAULT_READ_ALOUD_HOTKEY)}
                />
              </SettingsRow>
            </PanelRow>

            {/* Same gate as the hotkey: nothing here can make a sound without
                the model, and an inert list of 28 voices would only mislead. */}
            {installed && (
              <PanelRow>
                <VoicePicker
                  selectedVoiceId={resolveVoiceId(readAloudVoice)}
                  onSelect={setReadAloudVoice}
                />
              </PanelRow>
            )}
          </Panel>
        </>
      )}
    </div>
  );
}
