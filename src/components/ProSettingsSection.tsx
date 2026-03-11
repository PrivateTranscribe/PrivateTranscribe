import { useState, useEffect, useCallback } from "react";
import { Check, X, RefreshCw, Mail } from "lucide-react";
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

const PRO_FEATURES = [
  {
    name: "AI Enhancement",
    desc: "Automatically polish transcriptions with grammar fixes, formatting, and intelligent rewrites",
    available: true,
  },
  {
    name: "Voice Assistant",
    desc: "Customize your AI companion with a personal name and fine-tuned system prompts",
    available: true,
  },
  {
    name: "Correction Memory",
    desc: "Learns from your edits and automatically corrects recurring transcription errors",
    available: true,
  },
  {
    name: "Action Engine",
    desc: "Trigger custom voice commands to launch apps, run scripts, and automate workflows",
    available: true,
  },
  {
    name: "Smart Context (IDE Bridge)",
    desc: "Integrates with Cursor and VS Code for context-aware dictation while coding",
    available: false,
  },
];

const licensingReady = isLicensingConfigured();

export default function ProSettingsSection() {
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
        setStatus(getProStatus());
        setKeyInput("");
        toast({
          title: "License activated!",
          description: "Privoca Pro features are now unlocked.",
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

  return (
    <div className="space-y-8">
      {/* Status banner */}
      {status.isPro ? (
        <div className="rounded-xl border border-green-500/30 bg-green-500/5 p-5 flex items-start gap-3">
          <Check size={20} className="text-green-500 mt-0.5 shrink-0" />
          <div>
            <p className="text-sm font-medium text-foreground">Privoca Pro — Active</p>
            <p className="text-xs text-muted-foreground mt-1">
              License: <span className="font-mono">{status.licenseKey}</span>
              {status.offlineGrace && <span className="ml-2 text-amber-500">(offline mode)</span>}
            </p>
            {status.expiresAt && (
              <p className="text-xs text-muted-foreground mt-0.5">
                Next validation: {new Date(status.expiresAt).toLocaleDateString()}
              </p>
            )}
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
                className="text-xs text-red-400 hover:text-red-300"
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
              <h3 className="text-base font-semibold text-foreground">Activate Privoca Pro</h3>
              <p className="text-xs text-muted-foreground mt-0.5">
                Enter your license key to unlock all Pro features.
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
              <p className="text-xs text-red-400 flex items-center gap-1">
                <X size={12} /> {status.error}
              </p>
            )}
          </div>
        </>
      ) : (
        <>
          {/* Licensing not yet live — early access CTA */}
          <div className="rounded-xl border border-primary/20 bg-primary/5 p-6 space-y-4">
            <div>
              <h3 className="text-base font-semibold text-foreground">Get Privoca Pro</h3>
              <p className="text-sm text-muted-foreground mt-1">
                Privoca Pro is launching soon. Join the early-access list and be the first to know
                when licenses are available.
              </p>
            </div>
            <Button
              variant="default"
              size="sm"
              onClick={() =>
                window.electronAPI?.openExternal?.(
                  "mailto:support@privoca.com?subject=Privoca%20Pro%20Early%20Access"
                )
              }
              className="gap-2"
            >
              <Mail size={14} />
              Request early access
            </Button>
            <p className="text-xs text-muted-foreground">
              Already have a key?{" "}
              <a
                href="mailto:support@privoca.com"
                className="text-primary hover:underline"
                onClick={(e) => {
                  e.preventDefault();
                  window.electronAPI?.openExternal?.(
                    "mailto:support@privoca.com?subject=Privoca%20Pro%20Activation"
                  );
                }}
              >
                Contact support
              </a>{" "}
              for activation help.
            </p>
          </div>
        </>
      )}

      {/* Pro features overview */}
      <div className="space-y-3">
        <div>
          <h3 className="text-base font-semibold text-foreground">What's included</h3>
          <p className="text-xs text-muted-foreground mt-0.5">Features unlocked with Privoca Pro</p>
        </div>

        {PRO_FEATURES.map((feature) => (
          <div
            key={feature.name}
            className="flex items-center gap-3 rounded-lg border border-border-subtle bg-background/40 px-4 py-3"
          >
            <div
              className={`shrink-0 h-2 w-2 rounded-full ${
                feature.available ? "bg-green-500" : "bg-muted-foreground/30"
              }`}
            />
            <div className="min-w-0 flex-1">
              <span className="text-sm font-medium text-foreground">{feature.name}</span>
              <p className="text-xs text-muted-foreground">{feature.desc}</p>
            </div>
            <span
              className={`text-[10px] font-medium px-2 py-0.5 rounded ${
                feature.available
                  ? "bg-green-500/10 text-green-500"
                  : "bg-muted-foreground/10 text-muted-foreground"
              }`}
            >
              {feature.available ? "Ready" : "In development"}
            </span>
          </div>
        ))}
      </div>

      {/* Pricing info */}
      {!status.isPro && licensingReady && (
        <div className="rounded-xl border border-primary/20 bg-primary/5 p-5 space-y-3">
          <div className="space-y-1">
            <p className="text-sm font-medium text-foreground">
              One-time purchase — no subscription
            </p>
            <p className="text-xs text-muted-foreground">
              Privoca Pro is a single payment that unlocks all current Pro features. No recurring
              fees, no expiry.
            </p>
          </div>
          <Button
            variant="default"
            size="sm"
            onClick={() => window.electronAPI?.openExternal?.("https://privoca.com/pro")}
            className="gap-2"
          >
            Get Privoca Pro →
          </Button>
        </div>
      )}
    </div>
  );
}
