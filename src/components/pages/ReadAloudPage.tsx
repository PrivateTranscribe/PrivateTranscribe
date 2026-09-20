import { AudioLines, Download, Lock } from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Button } from "../ui/button";
import { Toggle } from "../ui/toggle";
import { HotkeyInput } from "../ui/HotkeyInput";
import { SettingsRow } from "../ui/SettingsSection";
import { DownloadProgressBar } from "../ui/DownloadProgressBar";
import { BetaBadge } from "../ui/BetaBadge";
import { BetaAccessLink } from "../ui/BetaAccessLink";
import { VoicePicker } from "../ui/VoicePicker";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { READ_ALOUD_SPEEDS } from "../../utils/readAloudSpeed";
import { useModelDownload } from "../../hooks/useModelDownload";
import { useSettings } from "../../hooks/useSettings";
import { isFeatureUnlocked } from "../../hooks/useProStatus";
import { DEFAULT_READ_ALOUD_HOTKEY } from "../../utils/hotkeys";
import defaultPlaybackHotkeys from "../../config/readAloudPlaybackHotkeys.json";
import {
  KOKORO_MODEL_DOWNLOAD_LABEL,
  KOKORO_MODEL_ID,
  KOKORO_MODEL_LABEL,
} from "../../models/kokoroVoices";
import type { KokoroModelStatus } from "../../types/electron";

/** Matches the panel treatment the other control-panel pages use. */
function Panel({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-xl border border-border-subtle/50 bg-surface-raised/50 divide-y divide-border-subtle/30 shadow-sm overflow-hidden">
      {children}
    </div>
  );
}

function PanelRow({ children }: { children: ReactNode }) {
  return <div className="px-5 py-3">{children}</div>;
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
    readAloudDuckOthers,
    setReadAloudDuckOthers,
    readAloudHotkey,
    setReadAloudHotkey,
    readAloudPlaybackHotkeys,
    setReadAloudPlaybackHotkeys,
    readAloudVoice,
    setReadAloudVoice,
    readAloudSpeed,
    setReadAloudSpeed,
    // Only read, to refuse a key one of these already owns.
    dictationKey,
    voiceCallMuteKey,
  } = useSettings();

  const [modelStatus, setModelStatus] = useState<KokoroModelStatus | null>(null);
  const [statusChecked, setStatusChecked] = useState(false);

  const refreshModelStatus = useCallback(async () => {
    try {
      const status = await window.electronAPI?.readAloudCheckModelStatus?.(KOKORO_MODEL_ID);
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
  const playbackControls = [
    {
      op: "toggle",
      label: "Pause or resume",
    },
    { op: "back", label: "Previous sentence" },
    { op: "forward", label: "Next sentence" },
  ] as const;
  const playbackHotkeys = { ...defaultPlaybackHotkeys, ...readAloudPlaybackHotkeys };
  const shortcutConflicts = [
    { label: "Dictation", hotkey: dictationKey },
    { label: "Mute my voice call", hotkey: voiceCallMuteKey },
    ...playbackControls.map(({ op, label }) => ({ label, hotkey: playbackHotkeys[op] })),
  ];

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
      return "Downloading voice model…";
    }
    if (!statusChecked) {
      return "Checking voice model…";
    }
    if (installed) {
      // Decimal MB, rounded — the download button says "326 MB", and the same
      // file must not appear to change size once it lands on disk.
      const mb = Math.round((modelStatus?.totalBytes ?? 0) / 1e6);
      return `${KOKORO_MODEL_LABEL} · ${mb} MB · Ready offline`;
    }
    return "Download once to read offline on this device.";
  };

  const modelPanel = (
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
              variant="ghost"
              size="sm"
              onClick={() => void deleteModel(KOKORO_MODEL_ID, refreshModelStatus)}
            >
              Delete model
            </Button>
          ) : (
            <Button
              size="sm"
              disabled={!statusChecked}
              onClick={() => void downloadModel(KOKORO_MODEL_ID)}
            >
              <Download size={14} aria-hidden />
              Download voice model ({KOKORO_MODEL_DOWNLOAD_LABEL})
            </Button>
          )}
        </SettingsRow>
      </PanelRow>
      {isDownloading && (
        <div data-testid="readaloud-download-progress">
          <DownloadProgressBar
            modelName={KOKORO_MODEL_LABEL}
            progress={downloadProgress}
            isInstalling={isInstalling}
          />
        </div>
      )}
    </Panel>
  );

  return (
    <div data-testid="readaloud-page" className="p-8 max-w-4xl mx-auto space-y-4">
      <div className="flex items-start gap-3">
        <AudioLines size={28} className="text-primary mt-0.5 shrink-0" />
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-3xl font-semibold text-foreground tracking-tight">Read Aloud</h1>
            <BetaBadge locked={!isUnlocked} />
          </div>
          <p className="text-sm text-muted-foreground mt-1">
            Read selected text aloud, privately on this device.{" "}
            <span className="text-foreground">English only.</span>
          </p>
        </div>
      </div>

      {!isUnlocked ? (
        <Panel>
          <div className="p-6 space-y-3">
            <Lock size={22} className="text-muted-foreground" />
            <h3 className="text-base font-semibold text-foreground">Hear it instead of reading</h3>
            <p className="text-sm text-muted-foreground">
              Read Aloud requires approved beta access. Nothing is downloaded until you choose.
            </p>
            <BetaAccessLink className="text-sm" />
          </div>
        </Panel>
      ) : (
        <>
          {!installed && modelPanel}
          <Panel>
            <PanelRow>
              <SettingsRow label="Read the selected text out loud">
                <Toggle
                  checked={readAloudEnabled}
                  onChange={setReadAloudEnabled}
                  disabled={!installed}
                />
              </SettingsRow>
            </PanelRow>
            <PanelRow>
              <div data-testid="readaloud-duck-others-row">
                <SettingsRow
                  label="Quiet other apps while reading"
                  description="Lowers music and video to 30%, then restores the volume."
                >
                  <Toggle
                    checked={readAloudDuckOthers}
                    onChange={setReadAloudDuckOthers}
                    disabled={!installed}
                  />
                </SettingsRow>
              </div>
            </PanelRow>
            {installed && (
              <PanelRow>
                <VoicePicker
                  value={readAloudVoice}
                  onChange={setReadAloudVoice}
                  testIdPrefix="readaloud"
                  ariaLabel="Voice"
                  collapsible
                />
              </PanelRow>
            )}
            <PanelRow>
              <SettingsRow label="Reading speed" description="Applies from your next reading.">
                <Select
                  value={String(readAloudSpeed)}
                  onValueChange={(value) => setReadAloudSpeed(Number(value))}
                  disabled={!installed}
                >
                  <SelectTrigger aria-label="Reading speed" className="w-40">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {READ_ALOUD_SPEEDS.map((speed) => (
                      <SelectItem key={speed} value={String(speed)}>
                        {speed === 1 ? "1× (Normal)" : `${speed}×`}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </SettingsRow>
            </PanelRow>
          </Panel>

          <Panel>
            <div className="px-5 py-3">
              <h2 className="text-sm font-semibold text-foreground">Keyboard shortcuts</h2>
            </div>
            <div
              data-testid="readaloud-shortcuts"
              className="px-5 divide-y divide-border-subtle/30"
            >
              <SettingsRow label="Read Aloud hotkey" className="py-2">
                <HotkeyInput
                  variant="shortcut"
                  value={readAloudHotkey}
                  onChange={setReadAloudHotkey}
                  disabled={!installed}
                  appliesToDictationHotkey={false}
                  ariaLabel="Read Aloud hotkey"
                  conflicts={shortcutConflicts}
                  resetHotkey={DEFAULT_READ_ALOUD_HOTKEY}
                />
              </SettingsRow>
              <div
                data-testid="readaloud-playback-shortcuts"
                className="divide-y divide-border-subtle/30"
              >
                {playbackControls.map(({ op, label }) => (
                  <SettingsRow key={op} label={label} className="py-2">
                    <HotkeyInput
                      variant="shortcut"
                      value={playbackHotkeys[op]}
                      onChange={(hotkey) =>
                        setReadAloudPlaybackHotkeys({ ...playbackHotkeys, [op]: hotkey })
                      }
                      resetHotkey={defaultPlaybackHotkeys[op]}
                      disabled={!installed}
                      appliesToDictationHotkey={false}
                      ariaLabel={label + " hotkey"}
                      conflicts={[
                        ...shortcutConflicts.filter((entry) => entry.label !== label),
                        { label: "Read Aloud", hotkey: readAloudHotkey },
                      ]}
                    />
                  </SettingsRow>
                ))}
              </div>
            </div>
            <p className="px-5 py-3 text-[12px] text-muted-foreground">
              Pause and skip shortcuts are active only during a read.
            </p>
          </Panel>
          {installed && modelPanel}
        </>
      )}
    </div>
  );
}
