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
  Languages,
  CircleSlash,
} from "lucide-react";
import AudioManager from "../../helpers/audioManager";
import { getEffectiveEntitlement, isFeatureUnlocked } from "../../hooks/useProStatus";
import { IconTile } from "../ui/IconTile";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { CheckboxField } from "../ui/checkbox";
import LanguageSelector from "../ui/LanguageSelector";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { useToast } from "../ui/Toast";
import { useSettings } from "../../hooks/useSettings";
import { formatBytes } from "../../utils/formatBytes";
import { LANGUAGE_OPTIONS } from "../../utils/languages";
import {
  buildLanguageMismatchNotice,
  type LanguageMismatchNotice,
} from "../../utils/languageMismatch";
import { buildStarterLimitMessage, recordStarterWords } from "../../utils/starterUsage";

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

type UploadStatus = "idle" | "drag-active" | "processing" | "success" | "error" | "cancelled";

/**
 * The stored language, only if it is still one the picker offers.
 *
 * The page used to hand this value straight to the engine. An unknown code kills
 * whisper-server outright (audit F3), and localStorage is editable, survives
 * downgrades, and outlives any list this app ships.
 */
function readStoredFileLanguage(): string {
  if (typeof window === "undefined") return "auto";
  const stored = window.localStorage?.getItem("fileTranscriptionLanguage") || "auto";
  return LANGUAGE_OPTIONS.some((option) => option.value === stored) ? stored : "auto";
}

/**
 * Whether a failure is "the model is not on disk" rather than something about
 * the file. Same test the main process uses to classify its own dictation
 * errors (ipcHandlers, transcribe-audio), so the two cannot drift apart.
 */
function isMissingModelError(message: string): boolean {
  const lower = message.toLowerCase();
  return lower.includes("model") && lower.includes("not downloaded");
}

/** "1m 05s" / "42s" — used for both elapsed time and audio length. */
function formatClockDuration(totalSeconds: number): string {
  const safe = Math.max(0, Math.round(totalSeconds));
  const minutes = Math.floor(safe / 60);
  const seconds = safe % 60;
  return minutes > 0 ? `${minutes}m ${String(seconds).padStart(2, "0")}s` : `${seconds}s`;
}

function getFileExtension(fileName: string): string {
  const parts = fileName.split(".");
  if (parts.length < 2) return "";
  return parts.pop()?.toLowerCase() || "";
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "Failed to transcribe this file. Please try again.";
}

type TranscribePageProps = {
  /**
   * Take the user to where local models are installed. Supplied by the control
   * panel shell; the missing-model error is useless without it, because nothing
   * on this page can put a model on disk.
   */
  onOpenModelSettings?: () => void;
};

export default function TranscribePage({ onOpenModelSettings }: TranscribePageProps = {}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const audioManagerRef = useRef<AudioManager | null>(null);
  const [status, setStatus] = useState<UploadStatus>("idle");
  const [selectedFileName, setSelectedFileName] = useState("");
  const [selectedFileSize, setSelectedFileSize] = useState(0);
  const [transcript, setTranscript] = useState("");
  const [srt, setSrt] = useState("");
  const [speakerCount, setSpeakerCount] = useState(0);
  // Whether speaker detection actually ran. Without it a count of 1 is
  // ambiguous: it is what the placeholder label says when detection was off,
  // and it is also what a detector that found no speaker change reports.
  const [speakerDetectionActive, setSpeakerDetectionActive] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [copied, setCopied] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(true);
  const [fileLanguage, setFileLanguageState] = useState(readStoredFileLanguage);
  // The file of the current run, kept so "Transcribe again in <language>" can
  // re-decode the same audio without asking the user to find it again.
  const lastFileRef = useRef<File | null>(null);
  // The id the main process knows this run by. Cleared the moment a run stops
  // being the current one, so a late result from a cancelled run is discarded
  // instead of overwriting the page.
  const activeJobIdRef = useRef<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [languageNotice, setLanguageNotice] = useState<LanguageMismatchNotice | null>(null);
  const [processingStartedAt, setProcessingStartedAt] = useState<number | null>(null);
  const [processingElapsedSeconds, setProcessingElapsedSeconds] = useState(0);
  const [transcriptionProgress, setTranscriptionProgress] = useState<{
    stage: string;
    percentage: number;
    chunksTotal?: number;
    chunksCompleted?: number;
    audioSeconds?: number;
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
    // Models not ready - will prompt download
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

  const elapsedLabel = useMemo(
    () => formatClockDuration(processingElapsedSeconds),
    [processingElapsedSeconds]
  );

  /**
   * The only progress that is really progress.
   *
   * whisper-server answers a request when the whole request is done and says
   * nothing while it works, so the percentage means something exactly when the
   * audio was split into chunks — one completed chunk is one real step. Below
   * the 20-minute chunking threshold the run is a single request, and the bar
   * this page used to render sat at 0 until it flashed 100 at the very end.
   * Rather than animate a number nobody measured, that case now shows what is
   * actually known: how long the run has taken, and how much audio it covers.
   */
  const chunkProgress = useMemo(() => {
    if (!transcriptionProgress || transcriptionProgress.stage !== "transcribing") return null;
    return (transcriptionProgress.chunksTotal ?? 0) > 1 ? transcriptionProgress : null;
  }, [transcriptionProgress]);

  const audioLengthLabel = useMemo(() => {
    const seconds = transcriptionProgress?.audioSeconds;
    return typeof seconds === "number" && seconds > 0 ? formatClockDuration(seconds) : "";
  }, [transcriptionProgress]);

  /**
   * What the run measured about speakers, or nothing.
   *
   * Detection off means there is nothing to report: every segment carries the
   * same placeholder label, so the "1 speaker" this page used to show was the
   * placeholder talking, not a measurement. Detection on with no second speaker
   * means the detector ran and found no speaker change — on the committed
   * three-voice fixture it finds none at all — so it says that instead of
   * claiming a count it never measured.
   */
  const speakerSummary = useMemo(() => {
    if (!speakerDetectionActive) return "";
    if (speakerCount > 1) return `${speakerCount} speakers`;
    return "No speaker turns found";
  }, [speakerDetectionActive, speakerCount]);

  const missingModel = status === "error" && isMissingModelError(errorMessage);

  /**
   * Local models are installed from Settings → Transcription, which is not on
   * this page and never was. The shell hands down the route; the main process
   * knows it too, so the button still works if this page is ever rendered
   * without the prop.
   */
  const openModelSettings = () => {
    if (onOpenModelSettings) {
      onOpenModelSettings();
      return;
    }
    void window.electronAPI?.openControlPanel?.({ page: "settings", settingsTab: "transcription" });
  };

  useEffect(() => {
    const mgr = new AudioManager();
    mgr._checkProEntitlement = () => isFeatureUnlocked("correction-memory");
    mgr._checkBetaFeatureAccess = (featureId: string) => isFeatureUnlocked(featureId);
    audioManagerRef.current = mgr;
    return () => {
      // Leaving the page used to leave the decode running in the main process
      // with nowhere to deliver its result — CPU spent on a transcript nobody
      // would ever see. cleanup() never covered it: it aborts the cloud
      // request controller, which the local file path does not register.
      const jobId = activeJobIdRef.current;
      activeJobIdRef.current = null;
      if (jobId) window.electronAPI?.cancelFileTranscription?.(jobId);
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
        // Needs download - show dialog
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
    activeJobIdRef.current = null;
    lastFileRef.current = null;
    setStatus("idle");
    setSelectedFileName("");
    setSelectedFileSize(0);
    setTranscript("");
    setSrt("");
    setSpeakerCount(0);
    setSpeakerDetectionActive(false);
    setErrorMessage("");
    setCopied(false);
    setTranscriptionProgress(null);
    setLanguageNotice(null);
    setCancelling(false);
  };

  /**
   * Stop the running decode.
   *
   * The id goes with the request so a Cancel that arrives after the run already
   * ended cannot stop the next one. The page drops its claim on the run
   * immediately, which is what makes a result that is already on its way back
   * land nowhere instead of on screen.
   */
  const cancelTranscription = async () => {
    const jobId = activeJobIdRef.current;
    if (!jobId) return;
    activeJobIdRef.current = null;
    setCancelling(true);
    try {
      await window.electronAPI?.cancelFileTranscription?.(jobId);
    } catch {
      // The run is already disowned above; a failed cancel call cannot make the
      // page lie about it.
    }
    setCancelling(false);
    setStatus("cancelled");
    setTranscriptionProgress(null);
    setProcessingStartedAt(null);
  };

  const processFile = async (file: File, languageOverride?: string) => {
    const manager = audioManagerRef.current;
    if (!manager) return;

    const jobId = `file-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    activeJobIdRef.current = jobId;
    lastFileRef.current = file;
    const isCurrentJob = () => activeJobIdRef.current === jobId;
    const requestedLanguage = languageOverride || fileLanguage;

    setLanguageNotice(null);
    setCancelling(false);
    setStatus("processing");
    setProcessingStartedAt(Date.now());
    setProcessingElapsedSeconds(0);
    setTranscriptionProgress(null);
    setErrorMessage("");
    setTranscript("");
    setSpeakerDetectionActive(false);
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
          language: requestedLanguage,
          translate: translateToEnglish === "on",
          jobId,
        });
      } else {
        result = await manager.processWithOpenAIAPI(file, metadata);
      }

      // The run was cancelled or replaced while the engine was working. Its
      // result belongs to nobody: showing it would contradict the page.
      if (!isCurrentJob()) return;

      if (result?.cancelled) {
        activeJobIdRef.current = null;
        setStatus("cancelled");
        setTranscriptionProgress(null);
        setProcessingStartedAt(null);
        return;
      }

      const text = result?.text?.trim();
      if (!text) {
        throw new Error("No text was transcribed from this file.");
      }

      if (getEffectiveEntitlement() !== "pro") {
        const usage = recordStarterWords(text);
        window.electronAPI?.analyticsTrack?.("starter_file_words_used", {
          words_added: usage.wordsAdded,
          words_used: usage.wordsUsed,
          daily_limit: usage.limit,
          limit_reached: usage.limitReached,
        });
        if (usage.limitReached) {
          window.electronAPI?.analyticsTrack?.("starter_limit_reached", {
            source: "file-transcription",
            words_used: usage.wordsUsed,
            daily_limit: usage.limit,
          });
          toast({
            title: "Starter limit reached",
            description: buildStarterLimitMessage(usage),
            variant: "default",
            duration: 8000,
          });
        }
      }

      if (historyLimit !== 0) {
        await window.electronAPI.saveTranscription(text, null, { includeInStats: false });
      }
      setTranscript(text);
      setSrt(result?.srt || "");
      setSpeakerCount(Number(result?.speakerCount) || 0);
      setSpeakerDetectionActive(result?.speakerDetectionActive === true);
      setLanguageNotice(
        buildLanguageMismatchNotice(result?.languageDetection, result?.requestedLanguage)
      );
      setStatus("success");
      activeJobIdRef.current = null;
      setProcessingStartedAt(null);
      toast({
        title: "Transcription complete",
        description: `${file.name} transcribed successfully.`,
        variant: "success",
      });
    } catch (error) {
      if (!isCurrentJob()) return;
      const message = toErrorMessage(error);
      activeJobIdRef.current = null;
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

  /**
   * Re-decode the same audio in the language the engine says it heard.
   *
   * The picker moves with it: this is the user choosing that language, so the
   * page must not keep claiming the old one.
   */
  const transcribeAgainInDetectedLanguage = () => {
    const notice = languageNotice;
    const file = lastFileRef.current;
    if (!notice || !file) return;
    setFileLanguage(notice.detected);
    processFile(file, notice.detected);
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
      <div className="mb-5 rounded-xl border border-border-subtle/50 bg-surface-raised/30">
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
              <CheckboxField
                id="file-noise-reduction"
                label="Noise reduction"
                description="Clean audio before transcription. Helps with calls, podcasts, and screen recordings."
                checked={noiseReduction}
                onChange={(event) => setNoiseReduction(event.target.checked)}
              />

              <CheckboxField
                id="file-speaker-labels"
                label="Speaker labels"
                description="Identify and label different speakers in the transcript."
                checked={speakerLabelsEnabled}
                onChange={(event) => handleSpeakerLabelsToggle(event.target.checked)}
              />
            </div>

            {/* Speaker count selector - only shown when speaker labels enabled */}
            {speakerLabelsEnabled && (
              <div className="rounded-lg border border-border-subtle/60 bg-background/25 px-4 py-3">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex items-center gap-2">
                    <Users size={14} className="text-muted-foreground" />
                    <div>
                      <p className="text-sm font-medium text-foreground">Number of speakers</p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        Set the number of speakers for best results. Auto-detect may over-segment.
                      </p>
                    </div>
                  </div>
                  <Select value={expectedSpeakers} onValueChange={setExpectedSpeakers}>
                    <SelectTrigger className="min-w-[160px] sm:w-[160px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {SPEAKER_COUNT_OPTIONS.map((opt) => (
                        <SelectItem key={opt.value} value={opt.value}>
                          {opt.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {/* Model status indicator */}
                {needsModelDownload && (
                  <div className="mt-3 flex items-center gap-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2">
                    <AlertCircle size={13} className="shrink-0 text-warning" />
                    <p className="text-xs text-warning">
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

            {/* A bar only where there is something to fill it: one completed
                chunk is one measured step. Everything else says elapsed time. */}
            {chunkProgress && (
              <div className="w-full max-w-xs mb-3">
                <div className="h-1.5 overflow-hidden rounded-full bg-primary/15">
                  <div
                    className="h-full rounded-full bg-primary transition-all duration-300 ease-out"
                    style={{ width: `${Math.min(100, chunkProgress.percentage)}%` }}
                  />
                </div>
                <p className="mt-1.5 text-[11px] text-muted-foreground tabular-nums text-center">
                  {`${chunkProgress.percentage}% · chunk ${chunkProgress.chunksCompleted} of ${chunkProgress.chunksTotal}`}
                </p>
              </div>
            )}

            <div className="flex items-center gap-2 rounded-full border border-border-subtle bg-surface-raised/60 px-3 py-1 text-[11px] text-muted-foreground">
              <span className="h-1.5 w-1.5 rounded-full bg-primary animate-pulse" />
              <span className="tabular-nums">{elapsedLabel} elapsed</span>
              {audioLengthLabel && (
                <>
                  <span className="text-muted-foreground/35">·</span>
                  <span className="tabular-nums">{audioLengthLabel} of audio</span>
                </>
              )}
            </div>

            {!chunkProgress && (
              <p className="mt-2 max-w-sm text-[11px] leading-relaxed text-muted-foreground">
                Whisper decodes this file in one pass and reports when it is finished, so there is
                no percentage to show along the way.
              </p>
            )}

            <Button
              size="sm"
              variant="outline"
              className="mt-4"
              onClick={cancelTranscription}
              disabled={cancelling}
              data-prevent-browse="true"
            >
              {cancelling ? "Stopping…" : "Cancel"}
            </Button>
          </>
        ) : status === "error" ? (
          <>
            <div className="w-16 h-16 rounded-2xl bg-destructive/10 flex items-center justify-center mb-5 shadow-lg">
              <AlertCircle size={28} className="text-destructive" />
            </div>
            <h3 className="text-lg font-semibold text-foreground mb-2">Transcription failed</h3>
            <p className="text-sm text-muted-foreground mb-5 max-w-2xl">{errorMessage}</p>
            {/* A missing model is the one failure another file cannot fix: no
                file will transcribe until the model is on disk, and this page
                holds no model picker. Offer the screen that does. */}
            {missingModel ? (
              <Button size="sm" onClick={openModelSettings} data-prevent-browse="true">
                <Download size={14} />
                Open model settings
              </Button>
            ) : (
              <Button size="sm" variant="outline" onClick={handleBrowse} data-prevent-browse="true">
                Try another file
              </Button>
            )}
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
              {speakerSummary && (
                // A count is a finding and reads as one; "nothing found" is a
                // note and should not shout louder than the result it sits next
                // to.
                <Badge variant={speakerCount > 1 ? "secondary" : "outline"} className="text-[10px]">
                  {speakerSummary}
                </Badge>
              )}
            </div>
          </>
        ) : status === "cancelled" ? (
          <>
            <div className="w-16 h-16 rounded-2xl bg-surface-raised flex items-center justify-center mb-5 shadow-lg">
              <CircleSlash size={28} className="text-muted-foreground" />
            </div>
            <h3 className="text-lg font-semibold text-foreground mb-1">Cancelled</h3>
            <p className="text-sm text-muted-foreground mb-1">{selectedFileName}</p>
            <p className="mb-5 max-w-md text-xs text-muted-foreground">
              {processingElapsedSeconds > 0
                ? `Stopped after ${elapsedLabel}. Nothing was transcribed and nothing was saved.`
                : "Stopped before the transcript was finished. Nothing was saved."}
            </p>
            <Button size="sm" variant="outline" onClick={handleBrowse} data-prevent-browse="true">
              Choose a file
            </Button>
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
                <IconTile size="md">
                  <FileText size={16} />
                </IconTile>
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-foreground">Transcript</p>
                  <p className="truncate text-xs text-muted-foreground">{selectedFileName}</p>
                </div>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground/75">
                <span>{transcriptStats.words.toLocaleString()} words</span>
                <span className="text-muted-foreground/35">·</span>
                <span>{transcriptStats.lines.toLocaleString()} lines</span>
                {speakerSummary && (
                  <>
                    <span className="text-muted-foreground/35">·</span>
                    <span>{speakerSummary}</span>
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

          {/* whisper-server reports what it heard on every response, including
              the ones it was ordered to decode as something else. Shown, not
              acted on: the language the user picked stays picked until they
              press the button. */}
          {languageNotice && (
            <div
              className="flex flex-col gap-3 border-b border-border-subtle/60 bg-warning/5 px-5 py-4 sm:flex-row sm:items-start sm:justify-between"
              data-prevent-browse="true"
            >
              <div className="flex gap-2.5">
                <Languages size={15} className="mt-0.5 shrink-0 text-warning" />
                <div>
                  <p className="text-sm font-medium text-foreground">
                    This audio sounds like {languageNotice.detectedLabel}, not{" "}
                    {languageNotice.forcedLabel}
                  </p>
                  <p className="mt-0.5 max-w-xl text-xs leading-relaxed text-muted-foreground">
                    Whisper detected {languageNotice.detectedLabel} with{" "}
                    {languageNotice.probabilityPercent}% confidence, then transcribed the file as{" "}
                    {languageNotice.forcedLabel} because that is the language selected here. Forcing
                    the wrong language returns fluent text that is not what was said.
                  </p>
                </div>
              </div>
              <Button
                size="sm"
                variant="outline"
                className="shrink-0"
                onClick={transcribeAgainInDetectedLanguage}
                data-prevent-browse="true"
              >
                Transcribe again in {languageNotice.detectedLabel}
              </Button>
            </div>
          )}

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
