import { useEffect, useRef, useState } from "react";
import { Play, Loader2 } from "lucide-react";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";
import ReasoningService from "../services/ReasoningService";
import { getModelProvider, modelRegistry, getCloudModel } from "../models/ModelRegistry";

const SAMPLE =
  "um hey Alex I can't attend the meeting tomorrow could you could you send me the notes afterwards and uh I'll I'll catch up on Friday thanks";
const CODING_SAMPLE =
  "uh fix the login button it does nothing after I reset my password the file is auth slash login dot ts";

export function EnhancementTest({
  model,
  provider,
  agentName,
  preferredLanguage,
  enabled,
  writingStyle = "clean",
}: {
  model: string;
  provider: string;
  agentName: string;
  preferredLanguage: string;
  enabled: boolean;
  writingStyle?: "clean" | "coding";
}) {
  const [text, setText] = useState(writingStyle === "coding" ? CODING_SAMPLE : SAMPLE);
  useEffect(() => {
    setText((current) =>
      current === SAMPLE || current === CODING_SAMPLE
        ? writingStyle === "coding"
          ? CODING_SAMPLE
          : SAMPLE
        : current
    );
  }, [writingStyle]);
  const [result, setResult] = useState<{ text: string; seconds: number; modelName: string } | null>(
    null
  );
  const [error, setError] = useState("");
  const [running, setRunning] = useState(false);
  const generation = useRef({ value: 0 });
  const feedback = useRef<HTMLDivElement>(null);
  const inFlight = useRef(false);
  useEffect(() => {
    const state = generation.current;
    state.value++;
    setResult(null);
    setError("");
    return () => {
      state.value++;
    };
  }, [model, provider, preferredLanguage, enabled, text, writingStyle]);
  useEffect(() => {
    if (result || error) feedback.current?.scrollIntoView({ block: "nearest" });
  }, [result, error]);

  const isLocal = provider === "local" || Boolean(modelRegistry.getProvider(provider));
  const run = async () => {
    if (inFlight.current || !text.trim() || !model || !enabled) return;
    const current = ++generation.current.value;
    const started = performance.now();
    inFlight.current = true;
    setRunning(true);
    setError("");
    setResult(null);
    const modelName =
      model === "claude-code"
        ? "Claude Code"
        : modelRegistry.getModel(model)?.model.name || getCloudModel(model)?.name || model;
    try {
      const cleaned = await ReasoningService.processText(text.trim(), model, agentName, {
        writingStyle,
        preferredLanguage,
        smartContext: null,
        timeoutMs: 30000,
        maxRetries: 0,
      });
      if (current === generation.current.value) {
        setResult({ text: cleaned, seconds: (performance.now() - started) / 1000, modelName });
      }
    } catch (cause) {
      if (current === generation.current.value)
        setError(cause instanceof Error ? cause.message : "Cleanup failed. Try again.");
    } finally {
      inFlight.current = false;
      setRunning(false);
    }
  };

  return (
    <section
      className="rounded-xl border border-border bg-card p-5 space-y-3"
      aria-labelledby="enhancement-test-title"
    >
      <div>
        <h2 id="enhancement-test-title" className="text-sm font-semibold text-foreground">
          {writingStyle === "coding" ? "Try a coding prompt" : "Try cleanup"}
        </h2>
        <p className="mt-1 text-xs text-muted-foreground">
          {writingStyle === "coding"
            ? "Check how your spoken description becomes instructions. "
            : "Check how the model handles fillers, repeated words, and punctuation. "}
          This test never pastes into another app.
        </p>
      </div>
      <Textarea
        aria-label="Text to clean up"
        value={text}
        onChange={(event) => setText(event.target.value)}
        className="min-h-20 resize-y text-sm"
        disabled={running}
      />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">
          {!enabled
            ? "Enable cleanup above to try it."
            : !model
              ? "Download or choose a model above first."
              : model === "claude-code"
                ? "Sends this text through your Claude Code login. Uses your Claude plan limits."
                : isLocal || getModelProvider(model) === "local"
                  ? "Runs locally on your PC."
                  : "Sends this text to your selected cloud provider."}
        </p>
        <Button onClick={run} disabled={running || !enabled || !model || !text.trim()} size="sm">
          {running ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
          {running ? "Enhancing…" : writingStyle === "coding" ? "Try coding prompt" : "Try cleanup"}
        </Button>
      </div>
      <div ref={feedback} aria-live="polite" aria-atomic="true">
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {result && (
          <div className="rounded-lg border border-border-subtle bg-surface-1 p-4 space-y-2">
            <div className="flex flex-wrap justify-between gap-2 text-xs text-muted-foreground">
              <span>{writingStyle === "coding" ? "Coding prompt" : "Cleaned text"}</span>
              <span>
                {result.modelName} · {result.seconds.toFixed(2)} s
              </span>
            </div>
            <p
              className="whitespace-pre-wrap break-words text-sm text-foreground"
              data-testid="cleanup-result"
            >
              {result.text || "No text remains after cleanup."}
            </p>
            <p className="text-xs text-muted-foreground">
              Check names, numbers, and meaning before relying on cleanup.
            </p>
          </div>
        )}
      </div>
    </section>
  );
}
