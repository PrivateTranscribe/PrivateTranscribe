import { Upload, FileAudio } from "lucide-react";
import { Badge } from "../ui/badge";

export default function TranscribePage() {
  return (
    <div className="p-8 max-w-5xl mx-auto">
      {/* Page header */}
      <div className="mb-8">
        <div className="flex items-center gap-3 mb-2">
          <h1 className="text-3xl font-semibold text-foreground tracking-tight">Transcribe</h1>
          <Badge variant="success" className="text-[10px]">
            New
          </Badge>
        </div>
        <p className="text-sm text-muted-foreground">Upload audio files for transcription</p>
      </div>

      {/* Drag-and-drop zone (placeholder) */}
      <div className="relative">
        <div className="rounded-2xl border-2 border-dashed border-border-subtle bg-surface-raised/30 p-12 flex flex-col items-center justify-center text-center min-h-[400px] transition-all duration-200 hover:border-primary/30 hover:bg-surface-raised/50">
          <div className="w-20 h-20 rounded-2xl bg-surface-raised flex items-center justify-center mb-6 shadow-lg">
            <Upload size={32} className="text-muted-foreground" />
          </div>

          <h3 className="text-lg font-semibold text-foreground mb-2">
            Drag files here or click to browse
          </h3>
          <p className="text-sm text-muted-foreground mb-6 max-w-md">
            Upload audio files to transcribe them using your selected model
          </p>

          <div className="flex items-center gap-2 text-xs text-muted-foreground/60 mb-3">
            <FileAudio size={14} />
            <span>Supported formats: WAV, MP3, M4A, OGG, FLAC</span>
          </div>
          <p className="text-xs text-muted-foreground/40">Maximum file size: 500MB</p>
        </div>

        {/* Coming Soon overlay */}
        <div className="absolute inset-0 bg-background/60 backdrop-blur-[2px] rounded-2xl flex items-center justify-center">
          <div className="text-center">
            <Badge className="mb-3 px-4 py-1.5 text-sm shadow-lg">Coming Soon</Badge>
            <p className="text-sm text-muted-foreground max-w-sm">
              File upload transcription is currently in development and will be available in a
              future update.
            </p>
          </div>
        </div>
      </div>

      {/* Feature description */}
      <div className="mt-8 rounded-xl border border-border-subtle/50 bg-surface-raised/30 p-6">
        <h4 className="text-sm font-semibold text-foreground mb-3">What's coming</h4>
        <ul className="space-y-2 text-sm text-muted-foreground">
          <li className="flex items-start gap-2">
            <span className="text-primary mt-0.5">•</span>
            <span>Batch transcription of multiple audio files at once</span>
          </li>
          <li className="flex items-start gap-2">
            <span className="text-primary mt-0.5">•</span>
            <span>Progress tracking with pause/resume support</span>
          </li>
          <li className="flex items-start gap-2">
            <span className="text-primary mt-0.5">•</span>
            <span>Export transcriptions in multiple formats (TXT, SRT, VTT)</span>
          </li>
          <li className="flex items-start gap-2">
            <span className="text-primary mt-0.5">•</span>
            <span>Automatic speaker diarization for multi-speaker audio</span>
          </li>
        </ul>
      </div>
    </div>
  );
}
