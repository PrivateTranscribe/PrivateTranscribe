import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type MouseEvent,
  type KeyboardEvent,
} from "react";
import {
  Upload,
  FileAudio,
  FileVideo,
  Loader2,
  AlertCircle,
  CheckCircle2,
  Copy,
  Download,
  FileText,
  Settings2,
  X,
} from "lucide-react";
import AudioManager from "../../helpers/audioManager";
import { getEffectiveEntitlement } from "../../hooks/useProStatus";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { useToast } from "../ui/Toast";
import { useSettings } from "../../hooks/useSettings";
import { formatBytes } from "../../utils/formatBytes";
import { getLanguageLabel } from "../../utils/languages";

const AUDIO_EXTENSIONS = ["wav", "mp3", "m4a", "ogg", "flac", "webm"] as const;
const VIDEO_EXTENSIONS = ["mp4", "m4v", "mov", "mkv", "avi", "webm"] as const;
const SUPPORTED_EXTENSIONS = new Set([...AUDIO_EXTENSIONS, ...VIDEO_EXTENSIONS]);
const ACCEPT_ATTR = [
  ...AUDIO_EXTENSIONS.map((ext) => `.${ext}`),
  ...VIDEO_EXTENSIONS.map((ext) => `.${ext}`),
].join(",");
const LOCAL_MAX_BYTES = 500 * 1024 * 1024;
const CLOUD_MAX_BYTES = 25 * 1024 * 1024;
type OutputFormat = "plain" | "timestamped" | "speakers";

type UploadStatus = "idle" | "drag-active" | "processing" | "success" | "error";

function getFileExtension(fileName: string): string {
  const parts = fileName.split(".");
  if (parts.length < 2) return "";
  return parts.pop()?.toLowerCase() || "";
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "Failed to transcribe this file. Please try again.";
}

export default function TranscribePage() {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const audioManagerRef = useRef<AudioManager | null>(null);
  const [status, setStatus] = useState<UploadStatus>("idle");
  const [selectedFileName, setSelectedFileName] = useState("");
  const [selectedFileSize, setSelectedFileSize] = useState(0);
  const [transcript, setTranscript] = useState("");
  const [srt, setSrt] = useState("");
  const [speakerCount, setSpeakerCount] = useState(0);
  const [errorMessage, setErrorMessage] = useState("");
  const [copied, setCopied] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(true);
  const [tdrzDownloaded, setTdrzDownloaded] = useState(false);
  const [speakerModelDialogOpen, setSpeakerModelDialogOpen] = useState(false);
  const [speakerModelDownloadStatus, setSpeakerModelDownloadStatus] = useState<
    "idle" | "downloading" | "success" | "error"
  >("idle");
  const [speakerModelProgress, setSpeakerModelProgress] = useState(0);
  const [speakerModelError, setSpeakerModelError] = useState("");
  const { toast } = useToast();
  const {
    useLocalWhisper,
    whisperModel,
    cloudTranscriptionProvider,
    cloudTranscriptionModel,
    preferredLanguage,
    translateToEnglish,
    useReasoningModel,
    reasoningModel,
    allowOpenAIFallback,
    allowLocalFallback,
    historyLimit,
    fileTranscriptionNoiseReduction: noiseReduction,
    setFileTranscriptionNoiseReduction: setNoiseReduction,
    fileTranscriptionSpeakerDetection: speakerDetection,
    setFileTranscriptionSpeakerDetection: setSpeakerDetection,
  } = useSettings();
  const outputFormat: OutputFormat = speakerDetection ? "speakers" : "timestamped";

  useEffect(() => {
    const mgr = new AudioManager();
    mgr._checkProEntitlement = () => getEffectiveEntitlement() === "pro";
    audioManagerRef.current = mgr;
    return () => {
      audioManagerRef.current?.cleanup();
      audioManagerRef.current = null;
    };
  }, []);

  const refreshSpeakerModelStatus = async () => {
    try {
      const status = await window.electronAPI?.checkModelStatus?.("small-en-tdrz");
      setTdrzDownloaded(Boolean(status?.downloaded));
      return Boolean(status?.downloaded);
    } catch {
      setTdrzDownloaded(false);
      return false;
    }
  };

  useEffect(() => {
    refreshSpeakerModelStatus();
  }, []);

  useEffect(() => {
    const unsubscribe = window.electronAPI?.onWhisperDownloadProgress?.((_event: unknown, data: any) => {
      if (data?.model !== "small-en-tdrz") return;
      if (data?.type === "progress") {
        setSpeakerModelDownloadStatus("downloading");
        setSpeakerModelProgress(Number(data?.percentage) || 0);
      }
      if (data?.type === "complete") {
        setSpeakerModelProgress(100);
        setSpeakerModelDownloadStatus("success");
        setTdrzDownloaded(true);
      }
    });
    return () => {
      if (typeof unsubscribe === "function") unsubscribe();
    };
  }, []);

  const currentMaxBytes = useMemo(
    () => (useLocalWhisper ? LOCAL_MAX_BYTES : CLOUD_MAX_BYTES),
    [useLocalWhisper]
  );

  const maxBytesLabel = useMemo(() => {
    if (useLocalWhisper) {
      return "Maximum file size: 500 MB (local mode)";
    }
    if (cloudTranscriptionProvider === "groq") {
      return "Maximum file size: 25 MB (Groq cloud mode)";
    }
    if (cloudTranscriptionProvider === "custom") {
      return "Maximum file size: 25 MB (custom cloud mode default)";
    }
    return "Maximum file size: 25 MB (OpenAI cloud mode)";
  }, [useLocalWhisper, cloudTranscriptionProvider]);

  const activeModelLabel = useMemo(() => {
    if (useLocalWhisper) {
      return `Whisper (${whisperModel || "base"})`;
    }
    return `${cloudTranscriptionProvider.toUpperCase()} (${cloudTranscriptionModel || "default"})`;
  }, [useLocalWhisper, whisperModel, cloudTranscriptionProvider, cloudTranscriptionModel]);

  const activeLanguageLabel = useMemo(() => {
    const spokenLanguage = getLanguageLabel(preferredLanguage || "auto");
    if (
      translateToEnglish === "on" &&
      preferredLanguage &&
      preferredLanguage !== "auto" &&
      preferredLanguage !== "en"
    ) {
      return `${spokenLanguage} → English`;
    }
    return spokenLanguage;
  }, [preferredLanguage, translateToEnglish]);

  const languageHintNotice = useMemo(() => {
    if (!preferredLanguage || preferredLanguage === "auto") return null;
    const spokenLanguage = getLanguageLabel(preferredLanguage);

    if (translateToEnglish === "on" && preferredLanguage !== "en") {
      return `This upload will use ${spokenLanguage} as the spoken-language hint and translate the result to English.`;
    }

    if (preferredLanguage === "en") {
      return "Language is set to English as the spoken-language hint. If this file is Danish or another language, choose Auto-detect or the real spoken language. This is not a translation setting.";
    }

    return `Language is set to ${spokenLanguage} as the spoken-language hint. If the file uses another language, choose Auto-detect or the real spoken language first.`;
  }, [preferredLanguage, translateToEnglish]);

  const fallbackLabel = useMemo(() => {
    if (useLocalWhisper) {
      return allowOpenAIFallback ? "Enabled (local -> cloud)" : "Disabled";
    }
    return allowLocalFallback ? "Enabled (cloud -> local)" : "Disabled";
  }, [useLocalWhisper, allowOpenAIFallback, allowLocalFallback]);

  const transcriptStats = useMemo(() => {
    const trimmed = transcript.trim();
    if (!trimmed) return { words: 0, lines: 0 };
    return {
      words: trimmed.split(/\s+/).filter(Boolean).length,
      lines: trimmed.split(/\n+/).filter((line) => line.trim()).length,
    };
  }, [transcript]);

  const validateFile = (file: File): string | null => {
    const extension = getFileExtension(file.name);

    if (!SUPPORTED_EXTENSIONS.has(extension)) {
      return "Unsupported file type. Upload audio/video files like MP3, WAV, MP4, MOV, MKV, or AVI.";
    }

    if (file.size <= 0) {
      return "File is empty. Please choose a valid file.";
    }

    if (file.size > currentMaxBytes) {
      return `File is too large (${formatBytes(file.size)}). Limit for current mode is ${formatBytes(currentMaxBytes)}.`;
    }

    return null;
  };

  const openSpeakerModelDialog = () => {
    setSpeakerModelDialogOpen(true);
    setSpeakerModelError("");
    if (!tdrzDownloaded && speakerModelDownloadStatus !== "downloading") {
      setSpeakerModelDownloadStatus("idle");
      setSpeakerModelProgress(0);
    }
  };

  const handleSpeakerDetectionChange = (checked: boolean) => {
    if (!checked) {
      setSpeakerDetection(false);
      return;
    }

    if (tdrzDownloaded) {
      setSpeakerDetection(true);
      return;
    }

    openSpeakerModelDialog();
  };

  const downloadSpeakerModel = async () => {
    setSpeakerModelDownloadStatus("downloading");
    setSpeakerModelProgress(0);
    setSpeakerModelError("");

    try {
      const result = await window.electronAPI?.downloadWhisperModel?.("small-en-tdrz");
      if (!result?.success && !result?.downloaded) {
        throw new Error(result?.error || "Speaker model download failed.");
      }
      await refreshSpeakerModelStatus();
      setSpeakerModelDownloadStatus("success");
      setSpeakerModelProgress(100);
      setSpeakerDetection(true);
      setSpeakerModelDialogOpen(false);
      toast({
        title: "Speaker detection ready",
        description: "Multi-speaker file transcription is now enabled.",
        variant: "success",
      });
    } catch (error) {
      const message = toErrorMessage(error);
      setSpeakerModelDownloadStatus("error");
      setSpeakerModelError(message);
      toast({
        title: "Model download failed",
        description: message,
        variant: "destructive",
      });
    }
  };

  const cancelSpeakerModelDownload = async () => {
    try {
      await window.electronAPI?.cancelWhisperDownload?.();
    } finally {
      setSpeakerModelDownloadStatus("idle");
      setSpeakerModelProgress(0);
    }
  };

  const handleBrowse = () => {
    if (status === "processing") return;
    inputRef.current?.click();
  };

  const handleDropzoneClick = (event: MouseEvent<HTMLDivElement>) => {
    if (status === "processing") return;
    const target = event.target as HTMLElement;
    if (target.closest("[data-prevent-browse='true']")) return;
    handleBrowse();
  };

  const handleDropzoneKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      handleBrowse();
    }
  };

  const resetState = () => {
    setStatus("idle");
    setSelectedFileName("");
    setSelectedFileSize(0);
    setTranscript("");
    setSrt("");
    setSpeakerCount(0);
    setErrorMessage("");
    setCopied(false);
  };

  const processFile = async (file: File) => {
    const manager = audioManagerRef.current;
    if (!manager) return;

    setStatus("processing");
    setErrorMessage("");
    setTranscript("");
    setCopied(false);
    setSelectedFileName(file.name);
    setSelectedFileSize(file.size);

    try {
      const metadata = {
        source: "upload",
        originalFileName: file.name,
        skipOptimization: true,
      };

      let result;
      if (useLocalWhisper) {
        result = await manager.processFileTranscriptionV2(file, whisperModel || "base", {
          ...metadata,
          noiseReduction,
          speakerDetection,
          outputFormat,
          language: preferredLanguage,
          translate: translateToEnglish === "on",
        });
      } else {
        result = await manager.processWithOpenAIAPI(file, metadata);
      }

      const text = result?.text?.trim();
      if (!text) {
        throw new Error("No text was transcribed from this file.");
      }

      if (historyLimit !== 0) {
        await window.electronAPI.saveTranscription(text, null, { includeInStats: false });
      }
      setTranscript(text);
      setSrt(result?.srt || "");
      setSpeakerCount(Number(result?.speakerCount) || 0);
      setStatus("success");
      toast({
        title: "Transcription complete",
        description: `${file.name} was transcribed successfully.`,
        variant: "success",
      });
    } catch (error) {
      const message = toErrorMessage(error);
      setErrorMessage(message);
      setStatus("error");
      toast({
        title: "Transcription failed",
        description: message,
        variant: "destructive",
      });
    }
  };

  const downloadText = (content: string, extension: "txt" | "srt") => {
    if (!content) return;
    const baseName = selectedFileName.replace(/\.[^/.]+$/, "") || "transcript";
    const blob = new Blob([content], { type: extension === "srt" ? "application/x-subrip" : "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${baseName}.${extension}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const handleFiles = (files: FileList | null) => {
    if (!files || files.length === 0) return;

    if (files.length > 1) {
      setStatus("error");
      setErrorMessage("Please upload one file at a time.");
      return;
    }

    const file = files[0];
    const validationError = validateFile(file);
    if (validationError) {
      setStatus("error");
      setSelectedFileName(file.name);
      setSelectedFileSize(file.size);
      setErrorMessage(validationError);
      return;
    }

    processFile(file);
  };

  const onInputChange = (event: ChangeEvent<HTMLInputElement>) => {
    handleFiles(event.target.files);
    event.target.value = "";
  };

  const onDragOver = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    if (status !== "processing") {
      setStatus("drag-active");
    }
  };

  const onDragLeave = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    if (status === "drag-active") {
      setStatus("idle");
    }
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    if (status === "processing") return;
    setStatus("idle");
    handleFiles(event.dataTransfer.files);
  };

  const copyTranscript = async () => {
    if (!transcript) return;
    try {
      await navigator.clipboard.writeText(transcript);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      toast({
        title: "Copied",
        description: "Transcript copied to clipboard.",
        variant: "success",
      });
    } catch {
      toast({
        title: "Copy failed",
        description: "Could not copy transcript to clipboard.",
        variant: "destructive",
      });
    }
  };

  return (
    <div className="p-8 max-w-5xl mx-auto">
      <div className="mb-8">
        <div className="flex items-center gap-3 mb-2">
          <h1 className="text-3xl font-semibold text-foreground tracking-tight">Transcribe</h1>
        </div>
        <p className="text-sm text-muted-foreground">
          Upload audio or video files for transcription
        </p>
      </div>

      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT_ATTR}
        onChange={onInputChange}
        className="hidden"
      />

      {speakerModelDialogOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4 backdrop-blur-sm">
          <div className="w-full max-w-md rounded-2xl border border-border-subtle bg-background shadow-2xl">
            <div className="flex items-start justify-between gap-4 border-b border-border-subtle px-5 py-4">
              <div>
                <h2 className="text-base font-semibold text-foreground">Enable speaker detection</h2>
                <p className="mt-1 text-xs text-muted-foreground leading-relaxed">
                  PrivateTranscribe needs to download a local speaker model before it can label
                  speakers in uploaded files. This stays on your computer.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setSpeakerModelDialogOpen(false)}
                disabled={speakerModelDownloadStatus === "downloading"}
                className="rounded-md p-1 text-muted-foreground hover:bg-surface-raised hover:text-foreground disabled:opacity-40"
                aria-label="Close speaker model dialog"
              >
                <X size={16} />
              </button>
            </div>

            <div className="space-y-4 px-5 py-4">
              <div className="rounded-xl border border-border-subtle bg-surface-raised/40 px-4 py-3">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-sm font-medium text-foreground">Small English speaker model</p>
                    <p className="text-xs text-muted-foreground">~466 MB · one-time download · fully local</p>
                  </div>
                  <Badge variant={tdrzDownloaded ? "success" : "outline"} className="text-[10px]">
                    {tdrzDownloaded ? "Ready" : "Required"}
                  </Badge>
                </div>
                {speakerModelDownloadStatus === "downloading" && (
                  <div className="mt-3 space-y-1.5">
                    <div className="h-1.5 overflow-hidden rounded-full bg-primary/15">
                      <div
                        className="h-full rounded-full bg-primary transition-all duration-200"
                        style={{ width: `${Math.min(100, Math.max(0, speakerModelProgress))}%` }}
                      />
                    </div>
                    <p className="text-[11px] text-muted-foreground">
                      Downloading… {speakerModelProgress}%
                    </p>
                  </div>
                )}
              </div>

              <p className="text-xs text-muted-foreground leading-relaxed">
                After this, users can upload an English meeting, podcast, or interview and get copyable text
                plus SRT export with Speaker 1, Speaker 2, etc.
              </p>
              <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs leading-relaxed text-amber-200">
                Speaker detection currently requires English audio. For Danish or other languages, leave it off for now.
              </div>

              {speakerModelError && (
                <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                  {speakerModelError}
                </div>
              )}
            </div>

            <div className="flex items-center justify-end gap-2 border-t border-border-subtle px-5 py-4">
              {speakerModelDownloadStatus === "downloading" ? (
                <Button variant="outline" size="sm" onClick={cancelSpeakerModelDownload}>
                  Cancel download
                </Button>
              ) : (
                <Button variant="outline" size="sm" onClick={() => setSpeakerModelDialogOpen(false)}>
                  Not now
                </Button>
              )}
              <Button
                size="sm"
                onClick={tdrzDownloaded ? () => {
                  setSpeakerDetection(true);
                              setSpeakerModelDialogOpen(false);
                } : downloadSpeakerModel}
                disabled={speakerModelDownloadStatus === "downloading"}
              >
                {tdrzDownloaded ? "Enable" : speakerModelDownloadStatus === "downloading" ? "Downloading…" : "Download & enable"}
              </Button>
            </div>
          </div>
        </div>
      )}

      <div className="mb-5 rounded-xl border border-border-subtle/50 bg-surface-raised/30 overflow-hidden">
        <button
          type="button"
          onClick={() => setSettingsOpen((open) => !open)}
          className="w-full px-5 py-3 flex items-center justify-between text-left"
        >
          <span className="flex items-center gap-2 text-sm font-medium text-foreground">
            <Settings2 size={15} /> File transcription settings
          </span>
          <span className="text-xs text-muted-foreground">{settingsOpen ? "Hide" : "Show"}</span>
        </button>
        {settingsOpen && (
          <div className="border-t border-border-subtle/40 px-5 pb-5 pt-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="rounded-lg border border-border-subtle/60 bg-background/25 px-4 py-3">
                <div className="flex items-center gap-3">
                  <input
                    id="file-noise-reduction"
                    type="checkbox"
                    checked={noiseReduction}
                    onChange={(event) => setNoiseReduction(event.target.checked)}
                    className="h-4 w-4 shrink-0 cursor-pointer accent-primary"
                  />
                  <span className="text-sm font-medium text-foreground">Noise reduction</span>
                </div>
                <p className="ml-7 mt-1 text-xs leading-relaxed text-muted-foreground">
                  Cleans uploaded audio before transcription. Best for noisy calls, podcasts, and screen recordings.
                </p>
              </div>

              <div className="rounded-lg border border-border-subtle/60 bg-background/25 px-4 py-3">
                <div className="flex items-center gap-3">
                  <input
                    id="file-speaker-detection"
                    type="checkbox"
                    checked={speakerDetection}
                    onChange={(event) => handleSpeakerDetectionChange(event.target.checked)}
                    className="h-4 w-4 shrink-0 cursor-pointer accent-primary"
                  />
                  <span className="text-sm font-medium text-foreground">Speaker detection</span>
                </div>
                <p className="ml-7 mt-1 text-xs leading-relaxed text-muted-foreground">
                  {tdrzDownloaded
                    ? `Adds Speaker 1 / Speaker 2 labels for English audio. Current language: ${activeLanguageLabel}.`
                    : "Downloads a local English-only speaker model when enabled."}
                </p>
                <p className="ml-7 mt-1 text-xs leading-relaxed text-amber-200/90">
                  English only for now — Danish and other languages may transcribe poorly with speaker detection enabled.
                </p>
                {!tdrzDownloaded && (
                  <button
                    type="button"
                    onClick={openSpeakerModelDialog}
                    className="ml-7 mt-2 text-xs font-medium text-primary hover:text-primary/80"
                  >
                    Set up speaker detection
                  </button>
                )}
              </div>
            </div>
          </div>
        )}
      </div>

      <div
        role="button"
        tabIndex={0}
        onClick={handleDropzoneClick}
        onKeyDown={handleDropzoneKeyDown}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        className={[
          "rounded-2xl border-2 border-dashed p-12 min-h-[320px] flex flex-col items-center justify-center text-center",
          "transition-all duration-200 select-none",
          status === "processing" ? "cursor-wait" : "cursor-pointer",
          status === "drag-active"
            ? "border-primary bg-primary/5"
            : "border-border-subtle bg-surface-raised/30 hover:border-primary/30 hover:bg-surface-raised/50",
        ].join(" ")}
      >
        {status === "processing" ? (
          <>
            <div className="w-20 h-20 rounded-2xl bg-surface-raised flex items-center justify-center mb-6 shadow-lg">
              <Loader2 size={32} className="text-primary animate-spin" />
            </div>
            <h3 className="text-lg font-semibold text-foreground mb-2">Transcribing file...</h3>
            <p className="text-sm text-muted-foreground mb-2">{selectedFileName}</p>
            <p className="text-xs text-muted-foreground/70 tabular-nums">
              {formatBytes(selectedFileSize)}
            </p>
          </>
        ) : status === "error" ? (
          <>
            <div className="w-20 h-20 rounded-2xl bg-destructive/10 flex items-center justify-center mb-6 shadow-lg">
              <AlertCircle size={32} className="text-destructive" />
            </div>
            <h3 className="text-lg font-semibold text-foreground mb-2">
              Could not transcribe file
            </h3>
            <p className="text-sm text-muted-foreground mb-5 max-w-2xl">{errorMessage}</p>
            <Button size="sm" variant="outline" onClick={handleBrowse} data-prevent-browse="true">
              Choose another file
            </Button>
          </>
        ) : status === "success" ? (
          <>
            <div className="w-20 h-20 rounded-2xl bg-success/10 flex items-center justify-center mb-6 shadow-lg">
              <CheckCircle2 size={32} className="text-success" />
            </div>
            <h3 className="text-lg font-semibold text-foreground mb-2">Transcription complete</h3>
            <p className="text-sm text-muted-foreground mb-2">{selectedFileName}</p>
            <div className="flex flex-wrap items-center justify-center gap-2 text-xs text-muted-foreground/70">
              <span className="tabular-nums">{formatBytes(selectedFileSize)}</span>
              {speakerCount > 0 && (
                <Badge variant="secondary" className="text-[10px]">
                  {speakerCount} speaker{speakerCount === 1 ? "" : "s"} detected
                </Badge>
              )}
            </div>
            <p className="mt-5 text-xs text-muted-foreground/60">Transcript is ready below.</p>
          </>
        ) : (
          <>
            <div className="w-20 h-20 rounded-2xl bg-surface-raised flex items-center justify-center mb-6 shadow-lg">
              <Upload size={32} className="text-muted-foreground" />
            </div>

            <h3 className="text-lg font-semibold text-foreground mb-2">
              Drag a file here or click to browse
            </h3>
            <p className="text-sm text-muted-foreground mb-6 max-w-xl">
              Upload a single audio or video file to transcribe with your current settings.
            </p>

            <div className="flex items-center gap-2 text-xs text-muted-foreground/70 mb-2">
              <FileAudio size={14} />
              <span>Audio: WAV, MP3, M4A, OGG, FLAC, WEBM</span>
            </div>
            <div className="flex items-center gap-2 text-xs text-muted-foreground/70 mb-3">
              <FileVideo size={14} />
              <span>Video: MP4, M4V, MOV, MKV, AVI, WEBM</span>
            </div>
            <p className="text-xs text-muted-foreground/50">{maxBytesLabel}</p>
          </>
        )}
      </div>

      {status === "success" && transcript && (
        <section className="mt-6 overflow-hidden rounded-2xl border border-border-subtle bg-surface-raised/40 shadow-sm">
          <div className="flex flex-col gap-4 border-b border-border-subtle/60 px-5 py-4 md:flex-row md:items-center md:justify-between">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <FileText size={16} />
                </span>
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-foreground">Transcript result</p>
                  <p className="truncate text-xs text-muted-foreground">{selectedFileName}</p>
                </div>
                {historyLimit !== 0 && (
                  <Badge variant="info" className="text-[10px]">
                    Saved to History
                  </Badge>
                )}
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground/75">
                <span>{transcriptStats.words.toLocaleString()} words</span>
                <span className="text-muted-foreground/35">•</span>
                <span>{transcriptStats.lines.toLocaleString()} lines</span>
                {speakerCount > 0 && (
                  <>
                    <span className="text-muted-foreground/35">•</span>
                    <span>{speakerCount} speaker{speakerCount === 1 ? "" : "s"}</span>
                  </>
                )}
              </div>
            </div>

            <div className="flex flex-wrap gap-2" data-prevent-browse="true">
              <Button size="sm" variant="outline" onClick={copyTranscript} data-prevent-browse="true">
                <Copy size={14} />
                {copied ? "Copied" : "Copy"}
              </Button>
              <Button size="sm" variant="outline" onClick={() => downloadText(transcript, "txt")} data-prevent-browse="true">
                <Download size={14} />
                TXT
              </Button>
              {srt && (
                <Button size="sm" variant="outline" onClick={() => downloadText(srt, "srt")} data-prevent-browse="true">
                  <Download size={14} />
                  SRT
                </Button>
              )}
              <Button size="sm" onClick={resetState} data-prevent-browse="true">
                New file
              </Button>
            </div>
          </div>

          <textarea
            readOnly
            value={transcript}
            spellCheck={false}
            className="block min-h-72 w-full resize-y border-0 bg-background/55 p-5 text-sm leading-7 text-foreground outline-none placeholder:text-muted-foreground/50 focus:ring-0"
          />
        </section>
      )}

      <div className="mt-6 rounded-xl border border-border-subtle bg-surface-raised/30 p-5">
        <div className="flex items-center justify-between mb-3">
          <p className="text-sm font-semibold text-foreground">Active settings</p>
          <Badge variant="outline" className="text-[10px]">
            Applied automatically
          </Badge>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
          <div className="rounded-lg border border-border-subtle/70 bg-surface-raised/40 px-3 py-2">
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground/70 mb-1">
              Model
            </p>
            <p className="text-foreground">{activeModelLabel}</p>
          </div>
          <div className="rounded-lg border border-border-subtle/70 bg-surface-raised/40 px-3 py-2">
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground/70 mb-1">
              Language
            </p>
            <p className="text-foreground">{activeLanguageLabel}</p>
          </div>
          <div className="rounded-lg border border-border-subtle/70 bg-surface-raised/40 px-3 py-2">
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground/70 mb-1">
              AI Enhancement
            </p>
            <p className="text-foreground">
              {useReasoningModel
                ? `Enabled${reasoningModel ? ` (${reasoningModel})` : ""}`
                : "Disabled"}
            </p>
          </div>
          <div className="rounded-lg border border-border-subtle/70 bg-surface-raised/40 px-3 py-2">
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground/70 mb-1">
              Fallback
            </p>
            <p className="text-foreground">{fallbackLabel}</p>
          </div>
        </div>
        {languageHintNotice && (
          <div className="mt-3 flex gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
            <AlertCircle size={14} className="mt-0.5 shrink-0" />
            <p>{languageHintNotice}</p>
          </div>
        )}
      </div>
    </div>
  );
}
