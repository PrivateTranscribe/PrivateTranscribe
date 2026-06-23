import { MessageSquare, Lock } from "lucide-react";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Badge } from "../ui/badge";
import PromptStudio from "../ui/PromptStudio";
import { useAgentName } from "../../utils/agentName";
import { isFeatureUnlocked } from "../../hooks/useProStatus";
import { useDialogs } from "../../hooks/useDialogs";
import { AlertDialog } from "../ui/dialog";

function SettingsPanel({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-border-subtle/50 bg-surface-raised/50 backdrop-blur-sm divide-y divide-border-subtle/30 shadow-sm overflow-hidden">
      {children}
    </div>
  );
}

function SettingsPanelRow({ children }: { children: React.ReactNode }) {
  return <div className="px-5 py-4">{children}</div>;
}

export default function VoiceAssistantPage() {
  const isUnlocked = isFeatureUnlocked("voice-assistant");
  const { agentName, setAgentName } = useAgentName();
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
          <MessageSquare size={28} className="text-primary" />
          <h1 className="text-3xl font-semibold text-foreground tracking-tight">Voice Assistant</h1>
          <Badge variant="warning" className="text-[10px]">
            Beta
          </Badge>
          {!isUnlocked && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium bg-[#A885FF]/10 text-[#A885FF] border border-[#A885FF]/20">
              <Lock size={10} /> Pro
            </span>
          )}
        </div>
        <p className="text-sm text-muted-foreground">
          Personalize your AI companion with a custom name and fine-tune system prompts
        </p>
      </div>

      {!isUnlocked && (
        <div className="rounded-xl border border-primary/20 bg-primary/5 p-6 text-center space-y-3 mb-8">
          <Lock size={24} className="mx-auto text-primary/60" />
          <h3 className="text-base font-semibold text-foreground">Make it yours</h3>
          <p className="text-sm text-muted-foreground max-w-md mx-auto">
            Name your assistant, then address it mid-dictation to switch from text cleanup to direct
            instruction mode. Fine-tune the system prompt to match your exact writing style and
            workflow. A Pro feature.
          </p>
        </div>
      )}

      {isUnlocked && (
        <>
          {/* Agent Name Section */}
          <div className="mb-10">
            <p className="text-[13px] font-medium text-foreground mb-3">Agent Name</p>
            <SettingsPanel>
              <SettingsPanelRow>
                <div className="space-y-3">
                  <div className="flex gap-2">
                    <Input
                      placeholder="e.g. Jarvis, Nova, Atlas..."
                      value={agentName}
                      onChange={(e) => setAgentName(e.target.value)}
                      className="flex-1 text-center text-base font-mono"
                    />
                    <Button
                      onClick={() => {
                        setAgentName(agentName.trim());
                        showAlertDialog({
                          title: "Agent Name Updated",
                          description: `Your agent is now named "${agentName.trim()}". Address it by saying "Hey ${agentName.trim()}" followed by your instructions.`,
                        });
                      }}
                      disabled={!agentName.trim()}
                      size="sm"
                    >
                      Save
                    </Button>
                  </div>
                  <p className="text-[11px] text-muted-foreground/60">
                    Pick something short and natural to say aloud
                  </p>
                </div>
              </SettingsPanelRow>
            </SettingsPanel>
          </div>

          {/* How it works */}
          <div className="mb-10">
            <p className="text-[13px] font-medium text-foreground mb-3">How it works</p>
            <SettingsPanel>
              <SettingsPanelRow>
                <p className="text-[12px] text-muted-foreground leading-relaxed">
                  When you say{" "}
                  <span className="font-medium text-foreground">"Hey {agentName}"</span> followed by
                  an instruction, the AI switches from cleanup mode to instruction mode. Without the
                  trigger phrase, it simply cleans up your dictation.
                </p>
              </SettingsPanelRow>
            </SettingsPanel>
          </div>

          {/* Examples */}
          <div className="mb-10">
            <p className="text-[13px] font-medium text-foreground mb-3">Examples</p>
            <SettingsPanel>
              <SettingsPanelRow>
                <div className="space-y-2.5">
                  {[
                    {
                      input: `Hey ${agentName}, write a formal email about the budget`,
                      mode: "Instruction",
                    },
                    {
                      input: `Hey ${agentName}, make this more professional`,
                      mode: "Instruction",
                    },
                    {
                      input: `Hey ${agentName}, convert this to bullet points`,
                      mode: "Instruction",
                    },
                    { input: "We should schedule a meeting for next week", mode: "Cleanup" },
                  ].map((example, i) => (
                    <div key={i} className="flex items-start gap-3">
                      <span
                        className={`shrink-0 mt-0.5 text-[10px] font-medium uppercase tracking-wider px-1.5 py-px rounded ${
                          example.mode === "Instruction"
                            ? "bg-primary/15 text-primary"
                            : "bg-muted text-muted-foreground"
                        }`}
                      >
                        {example.mode}
                      </span>
                      <p className="text-[12px] text-muted-foreground leading-relaxed">
                        "{example.input}"
                      </p>
                    </div>
                  ))}
                </div>
              </SettingsPanelRow>
            </SettingsPanel>
          </div>

          {/* Prompt Studio */}
          <div>
            <div className="mb-3">
              <p className="text-[13px] font-medium text-foreground">System Prompts</p>
              <p className="text-[11px] text-muted-foreground/60 mt-1">
                Fine-tune the AI's behavior and output style
              </p>
            </div>
            <PromptStudio />
          </div>
        </>
      )}
    </div>
  );
}
