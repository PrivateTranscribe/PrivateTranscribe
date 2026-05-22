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
  Users,
  Info,
} from "lucide-react";
import AudioManager from "../../helpers/audioManager";
import { getEffectiveEntitlement } from "../../hooks/useProStatus";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import LanguageSelector from "../ui/LanguageSelector";
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
const SPEAKER_COUNT_OPTIONS = [
  { value: "auto", label: "Auto-detect" },
  { value: "2", label: "2 speakers" },
  { value: "3", label: "3 speakers" },
  { value: "4", label: "4 speakers" },
  { value: "5", label: "5 speakers" },
  { value: "6", label: "6 speakers" },
] as const;
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
  const [fileLanguage, setFileLanguageState] = useState(() => {
    if (typeof window === "undefined") return "auto";
    return window.localStorage?.getItem("fileTranscriptionLanguage") || "auto";
  });
  const [processingStartedAt, setProcessingStartedAt] = useState<number | null>(null);
  const [processingElapsedSeconds, setProcessingElapsedSeconds] = useState(0);
  const [transcriptionProgress, setTranscriptionProgress] = useState<{
    stage: string;
    percentage: number;
    chunksTotal?: number;
    chunksCompleted?: number;
  } | null>(null);
  const [tdrzDownloaded, setTdrzDownloaded] = useState(false);
  const [diarizationReady, setDiarizationReady] = useState(false);
  const [diarizationDownloadStatus, setDiarizationDownloadStatus] = useState<
    "idle" | "downloading" | "success" | "error"
  >("idle");
  const [diarizationProgress, setDiarizationProgress] = useState(0);
  const [diarizationError, setDiarizationError] = useState("");
  const [modelDownloadDialogOpen, setModelDownloadDialogOpen] = useState(false);
  const { toast } = useToast();
  const {
    useLocalWhisper,
    whisperModel,
    cloudTranscriptionProvider,
    cloudTranscriptionModel,
    translateToEnglish,
    historyLimit,
    fileTranscriptionNoiseReduction: noiseReduction,
    setFileTranscriptionNoiseReduction: setNoiseReduction,
    fileTranscriptionSpeakerDetection: speakerLabelsEnabled,
    setFileTranscriptionSpeakerDetection: setSpeakerLabelsEnabled,
    setFileTranscriptionSpeakerDetectionMode: setSpeakerDetectionMode,
    fileTranscriptionExpectedSpeakers: expectedSpeakers,
    setFileTranscriptionExpectedSpeakers: setExpectedSpeakers,
  } = useSettings();

  // Determine the best diarization engine automatically based on available models and language.
  // Multilingual (sherpa-onnx) is preferred when available; TinyDiarize is a fallback for English-only.
  const resolvedDiarizationMode = useMemo(() => {
    if (!speakerLabelsEnabled) return "off" as const;
    if (diarizationReady) return "local-diarization" as const;
    if (tdrzDownloaded && (fileLanguage === "en" || fileLanguage === "auto"))
      return "tiny-diarize-en" as const;
    // Models not ready — will prompt download
    return "local-diarization" as const;
  }, [speakerLabelsEnabled, diarizationReady, tdrzDownloaded, fileLanguage]);

  const outputFormat: OutputFormat = speakerLabelsEnabled ? "speakers" : "timestamped";
  const isUsingLocalDiarization = resolvedDiarizationMode === "local-diarization";

  // Whether the user needs to download models before speaker labels will work
  const needsModelDownload =
    speakerLabelsEnabled &&
    !diarizationReady &&
    !(tdrzDownloaded && (fileLanguage === "en" || fileLanguage === "auto"));

  const setFileLanguage = (language: string) => {
    const next = language || "auto";
    setFileLanguageState(next);
    window.localStorage?.setItem("fileTranscriptionLanguage", next);
  };

  useEffect(() => {
    if (status !== "processing" || !processingStartedAt) return undefined;
    const updateElapsed = () => {
      setProcessingElapsedSeconds(
        Math.max(0, Math.floor((Date.now() - processingStartedAt) / 1000))
      );
    };
    updateElapsed();
    const id = window.setInterval(updateElapsed, 1000);
    return () => window.clearInterval(id);
  }, [processingStartedAt, status]);

  useEffect(() => {
    const unsubscribe = window.electronAPI?.onFileTranscriptionProgress?.(
      (_event: unknown, data: any) => {
        if (data && typeof data.stage === "string") {
          setTranscriptionProgress(data);
        }
      }
    );
    return () => {
      if (typeof unsubscribe === "function") unsubscribe();
    };
  }, []);

  const processingHint = useMemo(() => {
    if (speakerLabelsEnabled && isUsingLocalDiarization) {
      return "Transcribing and labeling speakers locally. Long files can take several minutes.";
    }
    if (useLocalWhisper) {
      return "Transcribing locally. Long files may take a few minutes.";
    }
    return "Uploading for cloud transcription.";
  }, [speakerLabelsEnabled, isUsingLocalDiarization, useLocalWhisper]);

  const elapsedLabel = useMemo(() => {
    const minutes = Math.floor(processingElapsedSeconds / 60);
    const seconds = processingElapsedSeconds % 60;
    return minutes > 0 ? `${minutes}m ${String(seconds).padStart(2, "0")}s` : `${seconds}s`;
  }, [processingElapsedSeconds]);

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

  const refreshDiarizationModelStatus = async () => {
    try {
      const status = await window.electronAPI?.checkDiarizationModelStatus?.();
      setDiarizationReady(Boolean(status?.ready));
      return Boolean(status?.ready);
    } catch {
      setDiarizationReady(false);
      return false;
    }
  };

  useEffect(() => {
    refreshSpeakerModelStatus();
    refreshDiarizationModelStatus();
  }, []);

  useEffect(() => {
    const unsubscribe = window.electronAPI?.onWhisperDownloadProgress?.(
      (_event: unknown, data: any) => {
        if (data?.model !== "small-en-tdrz") return;
        if (data?.type === "progress") {
          setDiarizationDownloadStatus("downloading");
          setDiarizationProgress(Number(data?.percentage) || 0);
        }
        if (data?.type === "complete") {
          setDiarizationProgress(100);
          setDiarizationDownloadStatus("success");
          setTdrzDownloaded(true);
        }
      }
    );
    return () => {
      if (typeof unsubscribe === "function") unsubscribe();
    };
  }, []);

  useEffect(() => {
    const unsubscribe = window.electronAPI?.onDiarizationDownloadProgress?.(
      (_event: unknown, data: any) => {
        if (data?.type === "progress") {
          setDiarizationDownloadStatus("downloading");
          setDiarizationProgress(Number(data?.percentage) || 0);
        }
        if (data?.type === "complete" || data?.stage === "complete") {
          setDiarizationProgress(100);
          setDiarizationDownloadStatus("success");
          setDiarizationReady(true);
        }
        if (data?.type === "error") {
          setDiarizationDownloadStatus("error");
          setDiarizationError(data?.error || "Model download failed.");
        }
      }
    );
    return () => {
      if (typeof unsubscribe === "function") unsubscribe();
    };
  }, []);

  const currentMaxBytes = useMemo(
    () => (useLocalWhisper ? LOCAL_MAX_BYTES : CLOUD_MAX_BYTES),
    [useLocalWhisper]
  );

  const maxBytesLabel = useMemo(() => {
    if (useLocalWhisper) return "Max 500 MB (local)";
    if (cloudTranscriptionProvider === "groq") return "Max 25 MB (Groq)";
    if (cloudTranscriptionProvider === "custom") return "Max 25 MB (custom)";
    return "Max 25 MB (cloud)";
  }, [useLocalWhisper, cloudTranscriptionProvider]);

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
      return `File is too large (${formatBytes(file.size)}). Limit is ${formatBytes(currentMaxBytes)}.`;
    }

    return null;
  };

  const handleSpeakerLabelsToggle = (checked: boolean) => {
    setSpeakerLabelsEnabled(checked);
    if (checked) {
      // Auto-select the best mode
      if (diarizationReady) {
        setSpeakerDetectionMode("local-diarization");
      } else if (tdrzDownloaded && (fileLanguage === "en" || fileLanguage === "auto")) {
        setSpeakerDetectionMode("tiny-diarize-en");
      } else {
        // Needs download — show dialog
        setSpeakerDetectionMode("local-diarization");
        setModelDownloadDialogOpen(true);
      }
    } else {
      setSpeakerDetectionMode("off");
    }
  };

  const downloadDiarizationModels = async () => {
    setDiarizationDownloadStatus("downloading");
    setDiarizationProgress(0);
    setDiarizationError("");

    try {
      const result = await window.electronAPI?.downloadDiarizationModels?.();
      if (!result?.success && !result?.ready) {
        throw new Error(result?.error || "Model download failed.");
      }
      await refreshDiarizationModelStatus();
      setDiarizationDownloadStatus("success");
      setDiarizationProgress(100);
      setSpeakerLabelsEnabled(true);
      setSpeakerDetectionMode("local-diarization");
      setModelDownloadDialogOpen(false);
      toast({
        title: "Speaker labels ready",
        description: "Speaker detection models are installed.",
        variant: "success",
      });
    } catch (error) {
      const message = toErrorMessage(error);
      setDiarizationDownloadStatus("error");
      setDiarizationError(message);
      toast({
        title: "Download failed",
        description: message,
        variant: "destructive",
      });
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
    setTranscriptionProgress(null);
  };

  const processFile = async (file: File) => {
    const manager = audioManagerRef.current;
    if (!manager) return;

    setStatus("processing");
    setProcessingStartedAt(Date.now());
    setProcessingElapsedSeconds(0);
    setTranscriptionProgress(null);
    setErrorMessage("");
    setTranscript("");
    setCopied(false);
    setSelectedFileName(file.name);
    setSelectedFileSize(file.size);

    try {
      if (speakerLabelsEnabled && isUsingLocalDiarization && !diarizationReady) {
        throw new Error(
          "Speaker label models need to be downloaded first. Enable speaker labels in settings to start the download."
        );
      }

      const metadata = {
        source: "upload",
        originalFileName: file.name,
        skipOptimization: true,
      };

      // Resolve expected speakers: "auto" → undefined (let clustering decide), otherwise parse as number
      const resolvedExpectedSpeakers =
        speakerLabelsEnabled && expectedSpeakers !== "auto" ? Number(expectedSpeakers) : undefined;

      let result;
      if (useLocalWhisper) {
        result = await manager.processFileTranscriptionV2(file, whisperModel || "base", {
          ...metadata,
          noiseReduction,
          speakerDetection: speakerLabelsEnabled,
          speakerDetectionMode: resolvedDiarizationMode,
          expectedSpeakers: resolvedExpectedSpeakers,
          outputFormat,
          language: fileLanguage,
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
      setProcessingStartedAt(null);
      toast({
        title: "Transcription complete",
        description: `${file.name} transcribed successfully.`,
        variant: "success",
      });
    } catch (error) {
      const message = toErrorMessage(error);
      setErrorMessage(message);
      setStatus("error");
      setProcessingStartedAt(null);
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
    const blob = new Blob([content], {
      type: extension === "srt" ? "application/x-subrip" : "text/plain",
    });
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
        description: "Could not copy to clipboard.",
        variant: "destructive",
      });
    }
  };

  return (
    <div className="p-8 max-w-5xl mx-auto">
      <div className="mb-8">
        <h1 className="text-3xl font-semibold text-foreground tracking-tight mb-1">Transcribe</h1>
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

      {/* Model download dialog */}
      {modelDownloadDialogOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4 backdrop-blur-sm">
          <div className="w-full max-w-md rounded-2xl border border-border-subtle bg-background shadow-2xl">
            <div className="flex items-start justify-between gap-4 border-b border-border-subtle px-5 py-4">
              <div>
                <h2 className="text-base font-semibold text-foreground">Download speaker models</h2>
                <p className="mt-1 text-xs text-muted-foreground leading-relaxed">
                  A one-time download is needed to label speakers in your files. Models run locally
                  on your computer.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setModelDownloadDialogOpen(false)}
                disabled={diarizationDownloadStatus === "downloading"}
                className="rounded-md p-1 text-muted-foreground hover:bg-surface-raised hover:text-foreground disabled:opacity-40"
                aria-label="Close"
              >
                <X size={16} />
              </button>
            </div>

            <div className="space-y-4 px-5 py-4">
              <div className="rounded-xl border border-border-subtle bg-surface-raised/40 px-4 py-3">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-sm font-medium text-foreground">
                      Speaker diarization models
                    </p>
                    <p className="text-xs text-muted-foreground">
                      ~150 MB · one-time download · works in any language
                    </p>
                  </div>
                  <Badge variant={diarizationReady ? "success" : "outline"} className="text-[10px]">
                    {diarizationReady ? "Ready" : "Required"}
                  </Badge>
                </div>
                {diarizationDownloadStatus === "downloading" && (
                  <div className="mt-3 space-y-1.5">
                    <div className="h-1.5 overflow-hidden rounded-full bg-primary/15">
                      <div
                        className="h-full rounded-full bg-primary transition-all duration-200"
                        style={{ width: `${Math.min(100, Math.max(0, diarizationProgress))}%` }}
                      />
                    </div>
                    <p className="text-[11px] text-muted-foreground">
                      Downloading… {diarizationProgress}%
                    </p>
                  </div>
                )}
              </div>

              {diarizationError && (
                <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                  {diarizationError}
                </div>
              )}
            </div>

            <div className="flex items-center justify-end gap-2 border-t border-border-subtle px-5 py-4">
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setModelDownloadDialogOpen(false);
                  setSpeakerLabelsEnabled(false);
                  setSpeakerDetectionMode("off");
                }}
              >
                Not now
              </Button>
              <Button
                size="sm"
                onClick={
                  diarizationReady
                    ? () => {
                        setModelDownloadDialogOpen(false);
                        setSpeakerLabelsEnabled(true);
                        setSpeakerDetectionMode("local-diarization");
                      }
                    : downloadDiarizationModels
                }
                disabled={diarizationDownloadStatus === "downloading"}
              >
                {diarizationReady
                  ? "Enable"
                  : diarizationDownloadStatus === "downloading"
                    ? "Downloading…"
                    : "Download & enable"}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Settings panel */}
      <div className="mb-5 rounded-xl border border-border-subtle/50 bg-surface-raised/30 overflow-hidden">
        <button
          type="button"
          onClick={() => setSettingsOpen((open) => !open)}
          className="w-full px-5 py-3 flex items-center justify-between text-left"
        >
          <span className="flex items-center gap-2 text-sm font-medium text-foreground">
            <Settings2 size={15} /> Settings
          </span>
          <span className="text-xs text-muted-foreground">{settingsOpen ? "Hide" : "Show"}</span>
        </button>
        {settingsOpen && (
          <div className="border-t border-border-subtle/40 px-5 pb-5 pt-4 space-y-4">
            {/* Language */}
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="text-sm font-medium text-foreground">Language</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  The spoken language of the file. Auto-detect works for most files.
                </p>
              </div>
              <LanguageSelector
                value={fileLanguage || "auto"}
                onChange={setFileLanguage}
                className="min-w-[200px]"
              />
            </div>

            <div className="h-px bg-border-subtle/40" />

            {/* Noise reduction + Speaker labels row */}
            <div className="grid gap-4 sm:grid-cols-2">
              {/* Noise reduction */}
              <div className="flex items-start gap-3">
                <input
                  id="file-noise-reduction"
                  type="checkbox"
                  checked={noiseReduction}
                  onChange={(event) => setNoiseReduction(event.target.checked)}
                  className="mt-0.5 h-4 w-4 shrink-0 cursor-pointer accent-primary"
                />
                <label htmlFor="file-noise-reduction" className="cursor-pointer">
                  <span className="text-sm font-medium text-foreground">Noise reduction</span>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    Clean audio before transcription. Helps with calls, podcasts, and screen
                    recordings.
                  </p>
                </label>
              </div>

              {/* Speaker labels */}
              <div className="flex items-start gap-3">
                <input
                  id="file-speaker-labels"
                  type="checkbox"
                  checked={speakerLabelsEnabled}
                  onChange={(event) => handleSpeakerLabelsToggle(event.target.checked)}
                  className="mt-0.5 h-4 w-4 shrink-0 cursor-pointer accent-primary"
                />
                <label htmlFor="file-speaker-labels" className="cursor-pointer">
                  <span className="text-sm font-medium text-foreground">Speaker labels</span>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    Identify and label different speakers in the transcript.
                  </p>
                </label>
              </div>
            </div>

            {/* Speaker count selector — only shown when speaker labels enabled */}
            {speakerLabelsEnabled && (
              <div className="rounded-lg border border-border-subtle/60 bg-background/25 px-4 py-3">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex items-center gap-2">
                    <Users size={14} className="text-muted-foreground" />
                    <div>
                      <p className="text-sm font-medium text-foreground">Number of speakers</p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        Auto-detect is recommended. Only set manually if you&apos;re certain.
                      </p>
                    </div>
                  </div>
                  <select
                    value={expectedSpeakers}
                    onChange={(e) => setExpectedSpeakers(e.target.value)}
                    className="h-9 rounded-lg border border-border-subtle bg-background px-3 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-primary min-w-[160px]"
                  >
                    {SPEAKER_COUNT_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                </div>

                {/* Model status indicator */}
                {needsModelDownload && (
                  <div className="mt-3 flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2">
                    <AlertCircle size={13} className="shrink-0 text-amber-400" />
                    <p className="text-xs text-amber-200">
                      Speaker models not yet downloaded.{" "}
                      <button
                        type="button"
                        onClick={() => setModelDownloadDialogOpen(true)}
                        className="font-medium text-primary hover:text-primary/80 underline underline-offset-2"
                      >
                        Download now
                      </button>
                    </p>
                  </div>
                )}
                {speakerLabelsEnabled && !needsModelDownload && (
                  <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground/70">
                    <Info size={12} className="shrink-0" />
                    <span>
                      {diarizationReady
                        ? "Using multilingual speaker detection. Works with any language."
                        : "Using English speaker turn detection."}
                    </span>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Drop zone */}
      <div
        role="button"
        tabIndex={0}
        onClick={handleDropzoneClick}
        onKeyDown={handleDropzoneKeyDown}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        className={[
          "rounded-2xl border-2 border-dashed p-12 min-h-[300px] flex flex-col items-center justify-center text-center",
          "transition-all duration-200 select-none",
          status === "processing" ? "cursor-wait" : "cursor-pointer",
          status === "drag-active"
            ? "border-primary bg-primary/5"
            : "border-border-subtle bg-surface-raised/30 hover:border-primary/30 hover:bg-surface-raised/50",
        ].join(" ")}
      >
        {status === "processing" ? (
          <>
            <div className="w-16 h-16 rounded-2xl bg-surface-raised flex items-center justify-center mb-5 shadow-lg">
              <Loader2 size={28} className="text-primary animate-spin" />
            </div>
            <h3 className="text-lg font-semibold text-foreground mb-1">
              {transcriptionProgress?.stage === "converting"
                ? "Preparing audio…"
                : transcriptionProgress?.stage === "diarizing"
                  ? "Identifying speakers…"
                  : "Transcribing…"}
            </h3>
            <p className="text-sm text-muted-foreground mb-1">{selectedFileName}</p>
            <p className="max-w-md text-xs text-muted-foreground mb-3">{processingHint}</p>

            {/* Progress bar */}
            {transcriptionProgress && transcriptionProgress.percentage > 0 && (
              <div className="w-full max-w-xs mb-3">
                <div className="h-1.5 overflow-hidden rounded-full bg-primary/15">
                  <div
                    className="h-full rounded-full bg-primary transition-all duration-300 ease-out"
                    style={{ width: `${Math.min(100, transcriptionProgress.percentage)}%` }}
                  />
                </div>
                <p className="mt-1.5 text-[11px] text-muted-foreground tabular-nums text-center">
                  {transcriptionProgress.stage === "transcribing" &&
                  transcriptionProgress.chunksTotal &&
                  transcriptionProgress.chunksTotal > 1
                    ? `${transcriptionProgress.percentage}% — chunk ${transcriptionProgress.chunksCompleted} of ${transcriptionProgress.chunksTotal}`
                    : `${transcriptionProgress.percentage}%`}
                </p>
              </div>
            )}

            <div className="flex items-center gap-2 rounded-full border border-border-subtle bg-surface-raised/60 px-3 py-1 text-[11px] text-muted-foreground">
              <span className="h-1.5 w-1.5 rounded-full bg-primary animate-pulse" />
              <span className="tabular-nums">{elapsedLabel}</span>
            </div>
          </>
        ) : status === "error" ? (
          <>
            <div className="w-16 h-16 rounded-2xl bg-destructive/10 flex items-center justify-center mb-5 shadow-lg">
              <AlertCircle size={28} className="text-destructive" />
            </div>
            <h3 className="text-lg font-semibold text-foreground mb-2">Transcription failed</h3>
            <p className="text-sm text-muted-foreground mb-5 max-w-2xl">{errorMessage}</p>
            <Button size="sm" variant="outline" onClick={handleBrowse} data-prevent-browse="true">
              Try another file
            </Button>
          </>
        ) : status === "success" ? (
          <>
            <div className="w-16 h-16 rounded-2xl bg-success/10 flex items-center justify-center mb-5 shadow-lg">
              <CheckCircle2 size={28} className="text-success" />
            </div>
            <h3 className="text-lg font-semibold text-foreground mb-1">Done</h3>
            <p className="text-sm text-muted-foreground mb-1">{selectedFileName}</p>
            <div className="flex flex-wrap items-center justify-center gap-2 text-xs text-muted-foreground/70">
              <span className="tabular-nums">{formatBytes(selectedFileSize)}</span>
              {speakerCount > 0 && (
                <Badge variant="secondary" className="text-[10px]">
                  {speakerCount} speaker{speakerCount === 1 ? "" : "s"}
                </Badge>
              )}
            </div>
          </>
        ) : (
          <>
            <div className="w-16 h-16 rounded-2xl bg-surface-raised flex items-center justify-center mb-5 shadow-lg">
              <Upload size={28} className="text-muted-foreground" />
            </div>
            <h3 className="text-lg font-semibold text-foreground mb-2">
              Drop a file here or click to browse
            </h3>
            <p className="text-sm text-muted-foreground mb-5 max-w-xl">
              Supports audio and video files up to {maxBytesLabel.toLowerCase().replace("max ", "")}
              .
            </p>
            <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-xs text-muted-foreground/60">
              <span className="flex items-center gap-1">
                <FileAudio size={12} /> WAV, MP3, M4A, OGG, FLAC
              </span>
              <span className="flex items-center gap-1">
                <FileVideo size={12} /> MP4, MOV, MKV, AVI, WEBM
              </span>
            </div>
          </>
        )}
      </div>

      {/* Transcript result */}
      {status === "success" && transcript && (
        <section className="mt-6 overflow-hidden rounded-2xl border border-border-subtle bg-surface-raised/40 shadow-sm">
          <div className="flex flex-col gap-4 border-b border-border-subtle/60 px-5 py-4 md:flex-row md:items-center md:justify-between">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <FileText size={16} />
                </span>
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-foreground">Transcript</p>
                  <p className="truncate text-xs text-muted-foreground">{selectedFileName}</p>
                </div>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground/75">
                <span>{transcriptStats.words.toLocaleString()} words</span>
                <span className="text-muted-foreground/35">·</span>
                <span>{transcriptStats.lines.toLocaleString()} lines</span>
                {speakerCount > 0 && (
                  <>
                    <span className="text-muted-foreground/35">·</span>
                    <span>
                      {speakerCount} speaker{speakerCount === 1 ? "" : "s"}
                    </span>
                  </>
                )}
              </div>
            </div>

            <div className="flex flex-wrap gap-2" data-prevent-browse="true">
              <Button
                size="sm"
                variant="outline"
                onClick={copyTranscript}
                data-prevent-browse="true"
              >
                <Copy size={14} />
                {copied ? "Copied" : "Copy"}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => downloadText(transcript, "txt")}
                data-prevent-browse="true"
              >
                <Download size={14} />
                TXT
              </Button>
              {srt && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => downloadText(srt, "srt")}
                  data-prevent-browse="true"
                >
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
    </div>
  );
}
