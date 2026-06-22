import { useEffect, useMemo, useState, type ReactNode } from "react";
import { MessageSquare, Loader2, CheckCircle2, AlertCircle } from "lucide-react";
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

export default function FeedbackDialog({
  currentVersion,
  source = "unknown",
  trigger,
}: FeedbackDialogProps) {
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [category, setCategory] = useState<FeedbackCategory>("general");
  const [includeSystemInfo, setIncludeSystemInfo] = useState(true);
  const [submitState, setSubmitState] = useState<"idle" | "submitting" | "sent" | "error">("idle");
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setSubmitState("idle");
    setSubmitError(null);
  }, [open]);

  const trimmedMessage = message.trim();
  const canSubmit = trimmedMessage.length >= 5 && submitState !== "submitting";

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
        includeSystemInfo,
        appVersion: currentVersion || "unknown",
        source,
      });

      if (!result?.success) {
        throw new Error(result?.error || "Feedback could not be sent right now.");
      }

      setSubmitState("sent");
      setMessage("");
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

        <div className="space-y-4">
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

          <label className="flex items-start gap-2 text-xs text-muted-foreground leading-relaxed cursor-pointer select-none">
            <input
              type="checkbox"
              checked={includeSystemInfo}
              onChange={(event) => setIncludeSystemInfo(event.target.checked)}
              className="mt-0.5 rounded"
            />
            <span>
              Include app version and basic system info. No audio, transcripts, or logs are sent.
            </span>
          </label>

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
