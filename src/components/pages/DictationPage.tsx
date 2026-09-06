import { Mic } from "lucide-react";
import SettingsPage from "../SettingsPage";

/**
 * Dictation is the product, so its setup gets a sidebar page like every other
 * feature instead of a tab inside Settings. The sections themselves still live
 * in SettingsPage under the "dictation" section id: the model picker, hotkey
 * and language rows are wired into that component's state, and rendering it
 * here keeps one copy of that wiring.
 */
export default function DictationPage() {
  return (
    <div className="p-8 max-w-4xl mx-auto space-y-6">
      <div className="flex items-start gap-3 mb-2">
        <Mic size={28} className="text-primary mt-0.5 shrink-0" />
        <div>
          <h1 className="text-3xl font-semibold text-foreground tracking-tight">Dictation</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Choose how dictation listens, transcribes, and pastes.
          </p>
        </div>
      </div>

      <SettingsPage activeSection="dictation" />
    </div>
  );
}
