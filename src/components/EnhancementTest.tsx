import { useEffect, useRef, useState } from "react";
import { Play, Loader2 } from "lucide-react";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";
import ReasoningService from "../services/ReasoningService";
import { getModelProvider, modelRegistry, getCloudModel } from "../models/ModelRegistry";
import { usePromptProfile } from "../hooks/usePromptProfile";
import { isShortDictation } from "../utils/shortDictation";

const SAMPLE =
  "um hey Alex I can't attend the meeting tomorrow could you could you send me the notes afterwards and uh I'll I'll catch up on Friday thanks";

type CleanupResult = {
  text?: string;
  error?: string;
  seconds: number;
  modelName: string;
  label: string;
  keptShort?: boolean;
};

export function EnhancementTest({
  model,
  provider,
  agentName,
  preferredLanguage,
  enabled,
}: {
  model: string;
  provider: string;
  agentName: string;
  preferredLanguage: string;
  enabled: boolean;
}) {
  const [text, setText] = useState(SAMPLE);
  const [result, setResult] = useState<CleanupResult[] | null>(null);
  const { profile, currentTemplate, experimentalTemplate } = usePromptProfile();
  const [progress, setProgress] = useState("");
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
  }, [
    model,
    provider,
    preferredLanguage,
    enabled,
    text,
    agentName,
    profile,
    currentTemplate,
    experimentalTemplate,
  ]);
  useEffect(() => {
    if (result || error) feedback.current?.scrollIntoView({ block: "nearest" });
  }, [result, error]);

  const isLocal = provider === "local" || Boolean(modelRegistry.getProvider(provider));
  const run = async (compare = false) => {
    if (inFlight.current || !text.trim() || !model || !enabled) return;
    const current = ++generation.current.value;
    inFlight.current = true;
    setRunning(true);
    setError("");
    setResult(null);
    const modelName =
      modelRegistry.getModel(model)?.model.name || getCloudModel(model)?.name || model;
    try {
      const selected =
        profile === "experimental"
          ? { label: "Experimental prompt", template: experimentalTemplate, preserveShort: true }
          : { label: "Current prompt", template: currentTemplate, preserveShort: false };
      const candidates = compare
        ? [
            { label: "Current prompt", template: currentTemplate, preserveShort: false },
            { label: "Experimental prompt", template: experimentalTemplate, preserveShort: true },
          ]
        : [selected];
      const results: CleanupResult[] = [];
      // The shared provider service accepts one request at a time. Freeze both
      // templates and the input for this run without switching the saved profile.
      for (const candidate of candidates) {
        if (current !== generation.current.value) break;
        setProgress(
          `Testing ${candidate.label.toLowerCase()}${compare ? ` (${results.length + 1}/2)` : ""}…`
        );
        const started = performance.now();
        try {
          const cleaned = await ReasoningService.processText(text.trim(), model, agentName, {
            promptTemplate: candidate.template,
            preserveShortDictation: candidate.preserveShort,
            preferredLanguage,
            smartContext: null,
            timeoutMs: 30000,
            maxRetries: 0,
          });
          results.push({
            text: cleaned,
            seconds: (performance.now() - started) / 1000,
            modelName,
            label: candidate.label,
            keptShort: candidate.preserveShort && isShortDictation(text),
          });
        } catch (cause) {
          if (!compare) throw cause;
          results.push({
            error: cause instanceof Error ? cause.message : "Cleanup failed.",
            seconds: (performance.now() - started) / 1000,
            modelName,
            label: candidate.label,
          });
        }
        if (current === generation.current.value) setResult([...results]);
      }
    } catch (cause) {
      if (current === generation.current.value)
        setError(cause instanceof Error ? cause.message : "Cleanup failed. Try again.");
    } finally {
      inFlight.current = false;
      setRunning(false);
      setProgress("");
    }
  };

  return (
    <section
      className="rounded-xl border border-border bg-card p-5 space-y-3"
      aria-labelledby="enhancement-test-title"
    >
      <div>
        <h2 id="enhancement-test-title" className="text-sm font-semibold text-foreground">
          Try cleanup
        </h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Test a word, a sentence, or a longer dictation. Compare prompts on the same text and
          model. Testing never pastes or changes your dictation prompt. A comparison makes two
          requests for longer text. Experimental keeps one or two words without a model rewrite.
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
              : isLocal || getModelProvider(model) === "local"
                ? "Runs locally on your PC."
                : "Sends this text to your selected cloud provider."}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button
            onClick={() => run()}
            disabled={running || !enabled || !model || !text.trim()}
            size="sm"
          >
            {running ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
            {running ? "Cleaning up…" : "Try cleanup"}
          </Button>
          <Button
            onClick={() => run(true)}
            disabled={running || !enabled || !model || !text.trim()}
            size="sm"
            variant="outline"
          >
            Compare both prompts
          </Button>
        </div>
      </div>
      <div ref={feedback} aria-live="polite" aria-atomic="true">
        {running && <p className="text-xs text-muted-foreground mb-3">{progress}</p>}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {result && (
          <div className="grid gap-3">
            {result.map((item) => (
              <div
                key={item.label}
                className="rounded-lg border border-border-subtle bg-surface-1 p-4 space-y-2"
              >
                <div className="flex flex-wrap justify-between gap-2 text-xs text-muted-foreground">
                  <span>{item.label}</span>
                  <span>
                    {item.keptShort
                      ? "Kept as spoken · no model call"
                      : `${item.modelName} · ${item.seconds.toFixed(2)} s`}
                  </span>
                </div>
                <p
                  className="whitespace-pre-wrap break-words text-sm text-foreground"
                  data-testid={result.length === 1 ? "cleanup-result" : "comparison-result"}
                >
                  {item.error ? (
                    <span role="alert" className="text-destructive">
                      {item.error}
                    </span>
                  ) : (
                    item.text || "No text remains after cleanup."
                  )}
                </p>
                <p className="text-xs text-muted-foreground">
                  Check names, numbers, and meaning before relying on cleanup.
                </p>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
