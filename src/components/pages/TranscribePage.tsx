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
  const [errorMessage, setErrorMessage] = useState("");
  const [copied, setCopied] = useState(false);
  const { toast } = useToast();
  const {
    useLocalWhisper,
    whisperModel,
    cloudTranscriptionProvider,
    cloudTranscriptionModel,
    preferredLanguage,
    useReasoningModel,
    reasoningModel,
    allowOpenAIFallback,
    allowLocalFallback,
    historyLimit,
  } = useSettings();

  useEffect(() => {
    const mgr = new AudioManager();
    mgr._checkProEntitlement = () => getEffectiveEntitlement() === "pro";
    audioManagerRef.current = mgr;
    return () => {
      audioManagerRef.current?.cleanup();
      audioManagerRef.current = null;
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

  const activeLanguageLabel = useMemo(
    () => getLanguageLabel(preferredLanguage || "auto"),
    [preferredLanguage]
  );

  const forcedLanguageWarning = useMemo(() => {
    if (!preferredLanguage || preferredLanguage === "auto") return null;
    return `This upload will be forced as ${getLanguageLabel(preferredLanguage)}. If the file is a different language, set Language to Auto-detect or the real spoken language first.`;
  }, [preferredLanguage]);

  const fallbackLabel = useMemo(() => {
    if (useLocalWhisper) {
      return allowOpenAIFallback ? "Enabled (local -> cloud)" : "Disabled";
    }
    return allowLocalFallback ? "Enabled (cloud -> local)" : "Disabled";
  }, [useLocalWhisper, allowOpenAIFallback, allowLocalFallback]);

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
        result = await manager.processWithLocalWhisper(file, whisperModel || "base", metadata);
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
            <p className="text-xs text-muted-foreground/70 tabular-nums mb-5">
              {formatBytes(selectedFileSize)}
            </p>
            <div className="flex items-center gap-2" data-prevent-browse="true">
              <Button
                size="sm"
                variant="outline"
                onClick={copyTranscript}
                data-prevent-browse="true"
              >
                <Copy size={14} />
                {copied ? "Copied" : "Copy transcript"}
              </Button>
              <Button size="sm" onClick={resetState} data-prevent-browse="true">
                Upload another
              </Button>
            </div>
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
        <div className="mt-6 rounded-xl border border-border-subtle bg-surface-raised/30 p-5">
          <div className="flex items-center justify-between mb-3">
            <p className="text-sm font-semibold text-foreground">Transcript</p>
            {historyLimit !== 0 && (
              <Badge variant="info" className="text-[10px]">
                Saved to History
              </Badge>
            )}
          </div>
          <p className="text-sm text-foreground leading-relaxed whitespace-pre-wrap">
            {transcript}
          </p>
        </div>
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
        {forcedLanguageWarning && (
          <div className="mt-3 flex gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
            <AlertCircle size={14} className="mt-0.5 shrink-0" />
            <p>{forcedLanguageWarning}</p>
          </div>
        )}
      </div>
    </div>
  );
}
