import {
  useEffect,
  useMemo,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type ReactNode,
} from "react";
import { MessageSquare, Loader2, CheckCircle2, AlertCircle, ImagePlus, X } from "lucide-react";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "./ui/dialog";
import { Textarea } from "./ui/textarea";

export type FeedbackCategory = "bug" | "confusing" | "feature" | "general";

interface FeedbackDialogProps {
  currentVersion?: string;
  source?: string;
  trigger?: ReactNode;
}

const CATEGORY_OPTIONS: Array<{
  value: FeedbackCategory;
  label: string;
  description: string;
}> = [
  { value: "bug", label: "Bug", description: "Something broke or failed" },
  {
    value: "confusing",
    label: "Confusing",
    description: "Setup, hotkey, paste, or copy was unclear",
  },
  { value: "feature", label: "Feature idea", description: "Something you wish it could do" },
  { value: "general", label: "General", description: "Anything else, including what worked" },
];

const MAX_ATTACHMENTS = 3;
const MAX_ATTACHMENT_SIZE_BYTES = 5 * 1024 * 1024;
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

type FeedbackAttachment = {
  name: string;
  type: string;
  size: number;
  dataUrl: string;
};

const readFileAsDataUrl = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("Could not read screenshot."));
    reader.readAsDataURL(file);
  });

export default function FeedbackDialog({
  currentVersion,
  source = "unknown",
  trigger,
}: FeedbackDialogProps) {
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [category, setCategory] = useState<FeedbackCategory>("general");
  const [attachments, setAttachments] = useState<FeedbackAttachment[]>([]);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [submitState, setSubmitState] = useState<"idle" | "submitting" | "sent" | "error">("idle");
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setSubmitState("idle");
    setSubmitError(null);
  }, [open]);

  const trimmedMessage = message.trim();
  const canSubmit = trimmedMessage.length >= 5 && submitState !== "submitting";

  const addAttachmentFiles = async (files: File[]) => {
    if (files.length === 0) return;

    setAttachmentError(null);
    const remainingSlots = MAX_ATTACHMENTS - attachments.length;
    if (remainingSlots <= 0) {
      setAttachmentError(`You can attach up to ${MAX_ATTACHMENTS} screenshots.`);
      return;
    }

    const acceptedFiles = files.slice(0, remainingSlots);
    if (files.length > remainingSlots) {
      setAttachmentError(
        `Only ${remainingSlots} more screenshot${remainingSlots === 1 ? "" : "s"} can be added.`
      );
    }

    const nextAttachments: FeedbackAttachment[] = [];
    for (const file of acceptedFiles) {
      if (!IMAGE_TYPES.has(file.type)) {
        setAttachmentError("Only PNG, JPG, WebP, or GIF images can be attached.");
        continue;
      }
      if (file.size > MAX_ATTACHMENT_SIZE_BYTES) {
        setAttachmentError("Each screenshot must be 5 MB or smaller.");
        continue;
      }
      try {
        const dataUrl = await readFileAsDataUrl(file);
        nextAttachments.push({
          name: file.name || `pasted-screenshot-${Date.now()}.png`,
          type: file.type,
          size: file.size,
          dataUrl,
        });
      } catch {
        setAttachmentError("Could not read that screenshot. Try saving it and adding it again.");
      }
    }

    if (nextAttachments.length > 0) {
      setAttachments((current) => [...current, ...nextAttachments].slice(0, MAX_ATTACHMENTS));
    }
  };

  const handleAttachmentChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files || []);
    event.target.value = "";
    await addAttachmentFiles(files);
  };

  const handlePastedImages = async (event: ClipboardEvent<HTMLDivElement>) => {
    const files = Array.from(event.clipboardData.items)
      .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter((file): file is File => Boolean(file));

    if (files.length === 0) return;
    event.preventDefault();
    await addAttachmentFiles(files);
  };

  const removeAttachment = (indexToRemove: number) => {
    setAttachments((current) => current.filter((_, index) => index !== indexToRemove));
    setAttachmentError(null);
  };

  const defaultTrigger = useMemo(
    () => (
      <Button type="button" size="sm" className="gap-1.5">
        <MessageSquare className="h-3.5 w-3.5" />
        Send Feedback
      </Button>
    ),
    []
  );

  const handleSubmit = async () => {
    if (!canSubmit) return;

    setSubmitState("submitting");
    setSubmitError(null);

    try {
      const result = await window.electronAPI?.submitFeedback?.({
        message: trimmedMessage,
        category,
        attachments,
        appVersion: currentVersion || "unknown",
        source,
      });

      if (!result?.success) {
        throw new Error(result?.error || "Feedback could not be sent right now.");
      }

      setSubmitState("sent");
      setMessage("");
      setAttachments([]);
    } catch (error) {
      setSubmitState("error");
      setSubmitError(
        error instanceof Error ? error.message : "Feedback could not be sent right now."
      );
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger || defaultTrigger}</DialogTrigger>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>Send Feedback</DialogTitle>
          <DialogDescription>Tell us what happened. No email app required.</DialogDescription>
        </DialogHeader>

        <div className="space-y-4" onPaste={handlePastedImages}>
          <label className="space-y-1.5 block">
            <span className="text-xs font-medium text-muted-foreground">Your note</span>
            <Textarea
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              placeholder="For example, install worked, but I did not know which hotkey to press."
              rows={6}
              autoFocus
            />
          </label>

          <div className="space-y-2">
            <div className="text-xs font-medium text-muted-foreground">Type</div>
            <div className="grid grid-cols-2 gap-2">
              {CATEGORY_OPTIONS.map((option) => {
                const selected = category === option.value;
                return (
                  <button
                    key={option.value}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => setCategory(option.value)}
                    className={`rounded-lg border px-3 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/50 ${
                      selected
                        ? "border-primary/60 bg-primary/10 text-foreground"
                        : "border-border-subtle bg-surface-raised text-foreground hover:border-primary/30"
                    }`}
                  >
                    <span className="block text-sm font-medium">{option.label}</span>
                    <span className="mt-0.5 block text-xs leading-snug text-muted-foreground">
                      {option.description}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-xs font-medium text-muted-foreground">Attach screenshots</div>
                <div className="text-[11px] leading-snug text-muted-foreground/80">
                  Paste screenshots here or use Add image. Up to {MAX_ATTACHMENTS} images, 5 MB
                  each.
                </div>
              </div>
              <Button type="button" variant="outline" size="sm" asChild>
                <label className="cursor-pointer gap-1.5">
                  <ImagePlus className="h-3.5 w-3.5" />
                  Add image
                  <input
                    type="file"
                    accept="image/png,image/jpeg,image/webp,image/gif"
                    multiple
                    className="sr-only"
                    onChange={handleAttachmentChange}
                  />
                </label>
              </Button>
            </div>

            {attachments.length > 0 && (
              <div className="space-y-1.5">
                {attachments.map((attachment, index) => (
                  <div
                    key={`${attachment.name}-${attachment.size}-${index}`}
                    className="flex items-center justify-between gap-2 rounded-lg border border-border-subtle bg-surface-raised px-3 py-2 text-xs"
                  >
                    <span className="min-w-0 truncate text-foreground">{attachment.name}</span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 shrink-0"
                      onClick={() => removeAttachment(index)}
                      aria-label={`Remove ${attachment.name}`}
                    >
                      <X className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                ))}
              </div>
            )}

            {attachmentError && <div className="text-xs text-destructive">{attachmentError}</div>}
          </div>

          <p className="rounded-lg border border-border-subtle bg-surface-raised px-3 py-2 text-xs leading-relaxed text-muted-foreground">
            Feedback includes app version and basic system info so we can reproduce issues. No
            audio, transcripts, or logs are sent. Screenshots are sent only if you attach them.
          </p>

          {submitState === "sent" && (
            <div className="flex items-center gap-2 rounded-lg border border-success/20 bg-success/10 px-3 py-2 text-sm text-success">
              <CheckCircle2 className="h-4 w-4" />
              Feedback sent. Thank you!
            </div>
          )}

          {submitState === "error" && (
            <div className="flex items-start gap-2 rounded-lg border border-destructive/20 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
              <span>{submitError}</span>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => setOpen(false)}>
            Close
          </Button>
          <Button type="button" onClick={handleSubmit} disabled={!canSubmit} className="gap-1.5">
            {submitState === "submitting" && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Send Feedback
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
