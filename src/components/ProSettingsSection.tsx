import { useState, useEffect, useCallback } from "react";
import { Check, ChevronRight, X, RefreshCw } from "lucide-react";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { useToast } from "./ui/Toast";
import {
  getProStatus,
  activateLicense,
  deactivateDevice,
  refreshProStatus,
  isLicensingConfigured,
  type ProStatus,
} from "../services/LicensingService";
import { setProPreview } from "../hooks/useProStatus";
import { SectionLabel } from "./ui/SectionLabel";
import type { ControlPanelDestination } from "../types/electron";

const PRO_FEATURES_INCLUDED = [
  {
    name: "Converse",
    desc: "Voice control for Claude Code runs you walk away from. Approve by voice, hear status, never reads code aloud.",
  },
  {
    name: "Coding prompt shortcuts",
    desc: "Hold Right Ctrl, describe the bug, release. A prompt lands in Claude Code, Cursor or Codex. Unlimited on Pro.",
  },
];

const PRO_FEATURES_BETA = [
  {
    name: "Correction Memory",
    desc: "Learns from your edits and automatically corrects recurring transcription errors",
  },
  {
    // Voice Assistant used to be listed separately here. Its assistant name and
    // prompt controls now live on the AI Enhancement page, so it is one line.
    name: "AI Enhancement",
    desc: "Polish transcriptions automatically, name the assistant you address mid-dictation, and tune the system prompt behind both",
  },
  {
    name: "Action Engine",
    desc: "Trigger custom voice commands to launch apps, run scripts, and automate workflows",
  },
];

/** Where each listed feature lives, so the card can open it. */
const FEATURE_PAGES: Record<string, string> = {
  "Correction Memory": "correction-memory",
  "AI Enhancement": "ai-enhancement",
  "Action Engine": "action-engine",
  Converse: "converse",
};

/** Features that are a settings section rather than a page of their own. */
const FEATURE_SETTINGS_DESTINATIONS: Record<string, ControlPanelDestination> = {
  "Coding prompt shortcuts": { page: "ai-enhancement" },
};

const PRO_FEATURES_COMING = [
  {
    name: "Smart Context",
    desc: "Context-aware dictation integrated with Cursor and VS Code - NDA-safe, no screenshots",
  },
];

const licensingReady = isLicensingConfigured();

export default function ProSettingsSection({
  onNavigate,
}: {
  /** Leaves Settings for a feature's own page. Cards are plain text without it. */
  onNavigate?: (page: string) => void;
} = {}) {
  const [status, setStatus] = useState<ProStatus>(getProStatus());
  const [keyInput, setKeyInput] = useState("");
  const [activating, setActivating] = useState(false);
  const [deactivating, setDeactivating] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const { toast } = useToast();

  useEffect(() => {
    setStatus(getProStatus());
  }, []);

  const handleActivate = useCallback(async () => {
    const key = keyInput.trim();
    if (!key) return;

    setActivating(true);
    try {
      const result = await activateLicense(key);
      if (result.success) {
        // A real activation should end any dev-only Starter/Pro/tester preview.
        // Otherwise the preview can keep a newly paid user artificially capped.
        setProPreview(null);
        setStatus(getProStatus());
        setKeyInput("");
        toast({
          title: "License activated!",
          description: "Unlimited private dictation is now unlocked.",
          variant: "success",
          duration: 4000,
        });
      } else {
        toast({
          title: "Activation failed",
          description: result.error || "Invalid license key",
          variant: "destructive",
          duration: 5000,
        });
      }
    } finally {
      setActivating(false);
    }
  }, [keyInput, toast]);

  const handleDeactivate = useCallback(async () => {
    setDeactivating(true);
    try {
      const result = await deactivateDevice();
      if (result.success) {
        setStatus(getProStatus());
        toast({
          title: "Device deactivated",
          description: "This device is no longer using your Pro license.",
          variant: "default",
          duration: 4000,
        });
      } else {
        toast({
          title: "Deactivation failed",
          description: result.error || "Could not deactivate",
          variant: "destructive",
        });
      }
    } finally {
      setDeactivating(false);
    }
  }, [toast]);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const newStatus = await refreshProStatus();
      setStatus(newStatus);
      toast({
        title: newStatus.isPro ? "License valid" : "License issue",
        description: newStatus.isPro
          ? "Your Pro license is active."
          : newStatus.error || "Could not validate license",
        variant: newStatus.isPro ? "success" : "destructive",
        duration: 3000,
      });
    } finally {
      setRefreshing(false);
    }
  }, [toast]);

  // Format key input with dashes
  const handleKeyChange = (value: string) => {
    const clean = value
      .replace(/[^A-Za-z0-9]/g, "")
      .toUpperCase()
      .slice(0, 16);
    const parts = clean.match(/.{1,4}/g) || [];
    setKeyInput(parts.join("-"));
  };

  const renderFeatureCard = (feature: { name: string; desc: string }) => {
    const page = FEATURE_PAGES[feature.name];
    const destination = FEATURE_SETTINGS_DESTINATIONS[feature.name];
    const open = destination
      ? () => void window.electronAPI?.openControlPanel?.(destination)
      : page && onNavigate
        ? () => onNavigate(page)
        : null;

    const body = (
      <>
        <Check size={14} className="shrink-0 text-pro" />
        <div className="min-w-0 flex-1">
          <span className="text-sm font-medium text-foreground">{feature.name}</span>
          <p className="text-xs text-muted-foreground">{feature.desc}</p>
        </div>
      </>
    );

    if (!open) {
      return (
        <div
          key={feature.name}
          className="flex items-center gap-3 rounded-lg border border-border-subtle bg-background/40 px-4 py-3"
        >
          {body}
        </div>
      );
    }

    return (
      <button
        key={feature.name}
        type="button"
        onClick={open}
        className="flex w-full items-center gap-3 rounded-lg border border-border-subtle bg-background/40 px-4 py-3 text-left transition-colors hover:border-pro/40 hover:bg-background/60"
      >
        {body}
        <ChevronRight size={14} className="shrink-0 text-muted-foreground" />
      </button>
    );
  };

  return (
    <div className="space-y-8">
      {/* Status banner */}
      {status.isPro ? (
        <div className="rounded-xl border border-pro/30 bg-pro-deep/20 p-5 flex items-start gap-3">
          <Check size={20} className="text-pro mt-0.5 shrink-0" />
          <div>
            <p className="text-sm font-medium text-foreground">PrivateTranscribe Pro - Active</p>
            <p className="text-xs text-muted-foreground mt-1">
              License: <span className="font-mono">{status.licenseKey}</span>
              {status.offlineGrace && <span className="ml-2 text-warning">(offline mode)</span>}
            </p>
            <p className="text-xs text-muted-foreground mt-0.5">
              Unlimited private dictation unlocked with your one-time Pro purchase.
            </p>
            <p className="text-xs text-muted-foreground mt-0.5">
              {status.betaAccess
                ? "Approved tester access is active for unfinished beta workflows."
                : "Unfinished beta workflows remain locked unless tester access is approved."}
            </p>
            <div className="flex items-center gap-2 mt-3">
              <Button
                variant="outline"
                size="sm"
                onClick={handleRefresh}
                disabled={refreshing}
                className="text-xs"
              >
                <RefreshCw size={12} className={`mr-1 ${refreshing ? "animate-spin" : ""}`} />
                {refreshing ? "Validating…" : "Validate"}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={handleDeactivate}
                disabled={deactivating}
                className="text-xs text-destructive hover:text-destructive/30"
              >
                {deactivating ? "Deactivating…" : "Deactivate this device"}
              </Button>
            </div>
          </div>
        </div>
      ) : licensingReady ? (
        <>
          {/* License key entry */}
          <div className="rounded-xl border border-border-subtle/50 bg-surface-raised/30 p-6 space-y-4">
            <div>
              <h3 className="text-base font-semibold text-foreground">
                Activate PrivateTranscribe Pro
              </h3>
              <p className="text-xs text-muted-foreground mt-0.5">
                Enter your license key to unlock unlimited private dictation.
              </p>
            </div>

            <div className="flex items-center gap-2">
              <input
                type="text"
                value={keyInput}
                onChange={(e) => handleKeyChange(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleActivate()}
                placeholder="XXXX-XXXX-XXXX-XXXX"
                className="h-9 px-3 rounded-lg bg-surface-raised border border-border-subtle text-sm text-foreground font-mono tracking-wider focus:outline-none focus:ring-2 focus:ring-primary/30 transition-all w-56"
                maxLength={19}
              />
              <Button
                variant="default"
                size="sm"
                onClick={handleActivate}
                disabled={activating || keyInput.replace(/-/g, "").length < 16}
              >
                {activating ? "Activating…" : "Activate"}
              </Button>
            </div>

            {status.error && (
              <p className="text-xs text-destructive flex items-center gap-1">
                <X size={12} /> {status.error}
              </p>
            )}

            {/* This is where someone discovers they cannot find the purchase
                email, so the self-serve recovery link belongs here rather than
                only on the website. */}
            <p className="text-xs text-muted-foreground">
              Lost your key?{" "}
              <button
                type="button"
                onClick={() =>
                  window.electronAPI?.openExternal?.("https://privatetranscribe.com/license")
                }
                className="text-pro hover:underline"
              >
                Have it emailed to you again
              </button>
              .
            </p>
          </div>
        </>
      ) : (
        <>
          {/* Licensing not yet live - purchase CTA */}
          <div className="rounded-xl border border-pro/25 bg-pro-deep/15 p-6 space-y-4">
            <div>
              <h3 className="text-base font-semibold text-foreground">Get PrivateTranscribe Pro</h3>
              <p className="text-sm text-muted-foreground mt-1 leading-relaxed">
                One-time purchase. Remove the Starter daily word limit permanently - no subscription
                or recurring fees.
              </p>
            </div>
            <Button
              variant="default"
              size="sm"
              onClick={() =>
                window.electronAPI?.openExternal?.("https://privatetranscribe.com/#pricing")
              }
              className="gap-2"
            >
              Get PrivateTranscribe Pro - €29 →
            </Button>
            <p className="text-xs text-muted-foreground">
              Bought Pro but cannot find the key?{" "}
              <button
                type="button"
                onClick={() =>
                  window.electronAPI?.openExternal?.("https://privatetranscribe.com/license")
                }
                className="text-pro hover:underline"
              >
                Have it emailed to you again
              </button>
              .
            </p>
          </div>
        </>
      )}

      {/* Pro features overview */}
      <div className="space-y-3">
        <div>
          <h3 className="text-base font-semibold text-foreground">What's included</h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            Pro includes Converse and unlimited coding prompt shortcuts.
          </p>
        </div>

        {PRO_FEATURES_INCLUDED.map((feature) => renderFeatureCard(feature))}

        <div className="pt-2">
          <div className="flex items-center gap-2">
            <h3 className="text-base font-semibold text-foreground">Beta features</h3>
            <Badge variant="warning" className="text-[10px]">
              Beta
            </Badge>
          </div>
          <p className="text-xs text-muted-foreground mt-0.5">
            Beta access is separate from Pro and requires tester approval.
          </p>
        </div>

        {PRO_FEATURES_BETA.map((feature) => renderFeatureCard(feature))}

        {PRO_FEATURES_COMING.length > 0 && (
          <div className="mt-4 space-y-2">
            <SectionLabel>Coming later</SectionLabel>
            {PRO_FEATURES_COMING.map((feature) => (
              <div
                key={feature.name}
                className="flex items-center gap-3 rounded-lg border border-border-subtle/50 bg-background/20 px-4 py-3 opacity-60"
              >
                <div className="shrink-0 h-3.5 w-3.5 rounded-full border border-muted-foreground/30 flex items-center justify-center">
                  <div className="h-1 w-1 rounded-full bg-muted-foreground/30" />
                </div>
                <div className="min-w-0 flex-1">
                  <span className="text-sm font-medium text-foreground">{feature.name}</span>
                  <p className="text-xs text-muted-foreground">{feature.desc}</p>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Pricing info */}
      {!status.isPro && licensingReady && (
        <div className="rounded-xl border border-pro/25 bg-pro-deep/15 p-5 space-y-3">
          <div className="space-y-1">
            <p className="text-sm font-medium text-foreground">
              One-time purchase - no subscription
            </p>
            <p className="text-xs text-muted-foreground">
              PrivateTranscribe Pro is a single payment that removes the daily word limit. Beta
              workflow access is separate until those features are stable.
            </p>
          </div>
          <Button
            variant="default"
            size="sm"
            onClick={() =>
              window.electronAPI?.openExternal?.("https://privatetranscribe.com/#pricing")
            }
            className="gap-2"
          >
            Get PrivateTranscribe Pro →
          </Button>
        </div>
      )}
    </div>
  );
}
