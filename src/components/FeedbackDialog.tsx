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

export type FeedbackCategory =
  | "install"
  | "onboarding"
  | "transcription"
  | "hotkey"
  | "performance"
  | "bug"
  | "confusing"
  | "feature"
  | "general";

interface FeedbackDialogProps {
  currentVersion?: string;
  source?: string;
  trigger?: ReactNode;
}

const CATEGORY_OPTIONS: Array<{ value: FeedbackCategory; label: string }> = [
  { value: "install", label: "Install / first launch" },
  { value: "onboarding", label: "Onboarding / setup" },
  { value: "transcription", label: "Dictation / transcription" },
  { value: "hotkey", label: "Hotkey / paste" },
  { value: "performance", label: "Speed / model download" },
  { value: "bug", label: "Other bug" },
  { value: "confusing", label: "Confusing UX" },
  { value: "feature", label: "Feature request" },
  { value: "general", label: "General feedback" },
];

const TESTER_PROMPTS: Array<{ label: string; category: FeedbackCategory; template: string }> = [
  {
    label: "Install failed",
    category: "install",
    template:
      "Install / launch feedback\nWindows version:\nDid SmartScreen appear? yes/no\nWhat happened when installing or opening the app?\n",
  },
  {
    label: "First dictation failed",
    category: "transcription",
    template:
      "First dictation feedback\nSpoken language:\nSelected model:\nDid recording start? yes/no\nDid text paste anywhere? yes/no\nWhat happened?\n",
  },
  {
    label: "Hotkey confusing",
    category: "hotkey",
    template:
      "Hotkey / paste feedback\nConfigured hotkey:\nApp you tried dictating into:\nDid the hotkey trigger recording? yes/no\nDid paste work? yes/no\nWhat felt confusing?\n",
  },
  {
    label: "It worked",
    category: "general",
    template:
      "Positive tester feedback\nWhat worked well?\nWhat app did you dictate into?\nWould you use this again tomorrow? yes/no\nWhat should be improved first?\n",
  },
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

  const applyTesterPrompt = (prompt: (typeof TESTER_PROMPTS)[number]) => {
    setCategory(prompt.category);
    setMessage((current) => {
      const trimmed = current.trim();
      if (!trimmed) return prompt.template;
      return `${trimmed}\n\n---\n${prompt.template}`;
    });
  };

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
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>Send Feedback</DialogTitle>
          <DialogDescription>
            In-app feedback for early access testers. No email app required.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="rounded-lg border border-primary/20 bg-primary/5 px-3 py-2 text-xs text-muted-foreground leading-relaxed">
            <strong className="text-foreground">Early access:</strong> short, honest notes are
            useful — bugs, confusing moments, missing features, or anything that felt surprisingly
            good.
          </div>

          <div className="space-y-2">
            <div className="text-xs font-medium text-muted-foreground">Quick tester templates</div>
            <div className="grid grid-cols-2 gap-2">
              {TESTER_PROMPTS.map((prompt) => (
                <button
                  key={prompt.label}
                  type="button"
                  onClick={() => applyTesterPrompt(prompt)}
                  className="rounded-lg border border-border-subtle bg-surface-raised px-3 py-2 text-left text-xs font-medium text-foreground transition-colors hover:border-primary/40 hover:bg-primary/5"
                >
                  {prompt.label}
                </button>
              ))}
            </div>
          </div>

          <label className="space-y-1.5 block">
            <span className="text-xs font-medium text-muted-foreground">Category</span>
            <select
              value={category}
              onChange={(event) => setCategory(event.target.value as FeedbackCategory)}
              className="w-full rounded-lg border border-border-subtle bg-surface-raised px-3 py-2 text-sm text-foreground outline-none focus:ring-1 focus:ring-primary/40"
            >
              {CATEGORY_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>

          <label className="space-y-1.5 block">
            <span className="text-xs font-medium text-muted-foreground">What happened?</span>
            <Textarea
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              placeholder="Example: I tried dictating into Notion, but the first word was missing..."
              rows={5}
              autoFocus
            />
          </label>

          <label className="flex items-start gap-2 text-xs text-muted-foreground leading-relaxed cursor-pointer select-none">
            <input
              type="checkbox"
              checked={includeSystemInfo}
              onChange={(event) => setIncludeSystemInfo(event.target.checked)}
              className="mt-0.5 rounded"
            />
            <span>
              Include basic system info: app version, platform, and Electron runtime versions. No
              audio, transcripts, or logs are sent.
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
