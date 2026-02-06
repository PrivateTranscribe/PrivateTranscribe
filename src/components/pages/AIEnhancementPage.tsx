import { Brain } from "lucide-react";
import ReasoningModelSelector from "../ReasoningModelSelector";
import { useSettings } from "../../hooks/useSettings";
import { useDialogs } from "../../hooks/useDialogs";
import { AlertDialog } from "../ui/dialog";

export default function AIEnhancementPage() {
  const {
    useReasoningModel,
    setUseReasoningModel,
    reasoningModel,
    setReasoningModel,
    reasoningProvider,
    setReasoningProvider,
    cloudReasoningBaseUrl,
    setCloudReasoningBaseUrl,
    openaiApiKey,
    setOpenaiApiKey,
    anthropicApiKey,
    setAnthropicApiKey,
    geminiApiKey,
    setGeminiApiKey,
    groqApiKey,
    setGroqApiKey,
    customReasoningApiKey,
    setCustomReasoningApiKey,
    updateReasoningSettings,
  } = useSettings();

  const { alertDialog, showAlertDialog, hideAlertDialog } = useDialogs();

  return (
    <div className="p-8 max-w-4xl mx-auto">
      <AlertDialog
        open={alertDialog.open}
        onOpenChange={hideAlertDialog}
        title={alertDialog.title}
        description={alertDialog.description}
        onOk={() => {}}
      />

      {/* Header */}
      <div className="mb-8">
        <div className="flex items-center gap-3 mb-2">
          <Brain size={28} className="text-primary" />
          <h1 className="text-3xl font-semibold text-foreground tracking-tight">AI Enhancement</h1>
        </div>
        <p className="text-sm text-muted-foreground">
          Automatically polish transcriptions with grammar fixes, formatting, and intelligent command
          handling
        </p>
      </div>

      {/* Before/After example */}
      <div className="mb-8 rounded-xl border border-border-subtle/50 bg-surface-raised/30 p-5">
        <p className="text-[11px] font-medium text-muted-foreground/60 uppercase tracking-wider mb-4">
          How it works
        </p>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <p className="text-[10px] text-muted-foreground/50 mb-2">Before (raw dictation)</p>
            <div className="rounded-lg bg-surface-1/50 border border-border-subtle/30 p-3">
              <p className="text-[12px] text-muted-foreground leading-relaxed italic">
                "so basically what i was thinking is that we should probably schedule a meeting for
                next week um to discuss the uh the budget for q2"
              </p>
            </div>
          </div>
          <div>
            <p className="text-[10px] text-primary/60 mb-2">After (AI enhanced)</p>
            <div className="rounded-lg bg-primary/5 border border-primary/10 p-3">
              <p className="text-[12px] text-foreground leading-relaxed">
                "We should schedule a meeting next week to discuss the Q2 budget."
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Model selector */}
      <ReasoningModelSelector
        useReasoningModel={useReasoningModel}
        setUseReasoningModel={(value) => {
          setUseReasoningModel(value);
          updateReasoningSettings({ useReasoningModel: value });
        }}
        setCloudReasoningBaseUrl={setCloudReasoningBaseUrl}
        cloudReasoningBaseUrl={cloudReasoningBaseUrl}
        reasoningModel={reasoningModel}
        setReasoningModel={setReasoningModel}
        localReasoningProvider={reasoningProvider}
        setLocalReasoningProvider={setReasoningProvider}
        openaiApiKey={openaiApiKey}
        setOpenaiApiKey={setOpenaiApiKey}
        anthropicApiKey={anthropicApiKey}
        setAnthropicApiKey={setAnthropicApiKey}
        geminiApiKey={geminiApiKey}
        setGeminiApiKey={setGeminiApiKey}
        groqApiKey={groqApiKey}
        setGroqApiKey={setGroqApiKey}
        customReasoningApiKey={customReasoningApiKey}
        setCustomReasoningApiKey={setCustomReasoningApiKey}
        showAlertDialog={showAlertDialog}
      />
    </div>
  );
}
