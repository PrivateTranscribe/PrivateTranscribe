import { AudioLines, Download, Lock } from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Button } from "../ui/button";
import { Toggle } from "../ui/toggle";
import { HotkeyInput } from "../ui/HotkeyInput";
import { InfoBox } from "../ui/InfoBox";
import { SettingsRow } from "../ui/SettingsSection";
import { DownloadProgressBar } from "../ui/DownloadProgressBar";
import { BetaBadge } from "../ui/BetaBadge";
import { BetaAccessLink } from "../ui/BetaAccessLink";
import { useModelDownload } from "../../hooks/useModelDownload";
import { useSettings } from "../../hooks/useSettings";
import { isFeatureUnlocked } from "../../hooks/useProStatus";
import { DEFAULT_READ_ALOUD_HOTKEY } from "../../utils/hotkeys";
import type { KokoroModelStatus } from "../../types/electron";

/** The one Kokoro model in the registry. */
const READ_ALOUD_MODEL_ID = "kokoro-82m-v1.0-fp32";
const READ_ALOUD_MODEL_LABEL = "Kokoro 82M";
/** Registry total, stated up front so the download is never a surprise. */
const READ_ALOUD_DOWNLOAD_LABEL = "326 MB";

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

/** Said in every unlocked state, because the limit is not a footnote. */
function EnglishOnlyNotice() {
  return (
    <InfoBox variant="muted" className="text-[13px] leading-relaxed text-muted-foreground">
      <span className="font-medium text-foreground">English only for now.</span> The Kokoro voice
      ships no Danish, so Read Aloud speaks English text and mispronounces the rest.
    </InfoBox>
  );
}

/**
 * Read Aloud: the voice model, the global shortcut, and the honest limits of
 * both.
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
          </Panel>
        </>
      )}
    </div>
  );
}
