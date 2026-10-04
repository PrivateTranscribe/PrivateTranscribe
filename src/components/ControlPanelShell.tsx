import { useState, useEffect, useLayoutEffect, useRef } from "react";
import { Button } from "./ui/button";
import { Download, RefreshCw, Loader2 } from "lucide-react";
import AppSidebar, { PageId } from "./AppSidebar";
import TitleBar from "./TitleBar";
import { ConfirmDialog, AlertDialog } from "./ui/dialog";
import { useDialogs } from "../hooks/useDialogs";
import { useToast } from "./ui/Toast";
import { useUpdater } from "../hooks/useUpdater";
import { trackAnalyticsEvent } from "../utils/analytics";
import { resolveExperimentalPage, useExperimentalFeatures } from "../utils/experimentalFeatures";

import DashboardPage from "./pages/DashboardPage";
import HistoryPage from "./pages/HistoryPage";
import TranscribePage from "./pages/TranscribePage";
import DictionaryPage from "./pages/DictionaryPage";
import ReadAloudPage from "./pages/ReadAloudPage";
import AIEnhancementPage from "./pages/AIEnhancementPage";
import ConversePage from "./pages/ConversePage";
import ActionEnginePage from "./pages/ActionEnginePage";
import DictationPage from "./pages/DictationPage";
import SettingsPageWrapper from "./pages/SettingsPageWrapper";
import type { SettingsSectionType } from "./SettingsPage";

import { AnalyticsConsentModal } from "./AnalyticsConsentModal";

export default function ControlPanelShell() {
  const [requestedPage, setActivePage] = useState<PageId>("home");
  const [experimentalFeaturesEnabled] = useExperimentalFeatures();
  // Resolved at render, so a stale saved or requested id never mounts a hidden page.
  const activePage = resolveExperimentalPage(requestedPage, experimentalFeaturesEnabled);
  const contentRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (activePage !== requestedPage) setActivePage(activePage);
  }, [activePage, requestedPage]);

  useLayoutEffect(() => {
    contentRef.current?.scrollTo({ top: 0 });
  }, [activePage]);
  const [settingsTabRequest, setSettingsTabRequest] = useState<{
    section?: SettingsSectionType;
    requestId: number;
  }>({ requestId: 0 });
  const [showConsentModal, setShowConsentModal] = useState(false);
  const { toast } = useToast();
  const { confirmDialog, alertDialog, showConfirmDialog, hideConfirmDialog, hideAlertDialog } =
    useDialogs();
  const {
    status: updateStatus,
    info: updateInfo,
    downloadProgress,
    isDownloading,
    isInstalling,
    downloadUpdate,
    installUpdate,
    error: updateError,
  } = useUpdater();

  useEffect(() => {
    const requestedPage = localStorage.getItem("controlPanelInitialPage");
    if (!requestedPage) {
      return;
    }

    const validPages: PageId[] = [
      "home",
      "history",
      "transcribe",
      "dictation",
      "dictionary",
      "read-aloud",
      "ai-enhancement",
      "converse",
      "correction-memory",
      "action-engine",
      "settings",
    ];

    if (validPages.includes(requestedPage as PageId)) {
      setActivePage(requestedPage as PageId);
    }

    localStorage.removeItem("controlPanelInitialPage");
  }, []);

  useEffect(() => {
    return window.electronAPI?.onControlPanelNavigate?.((destination) => {
      const requestedPage = destination.page;
      setActivePage(requestedPage);
      if (destination.settingsTab) {
        setSettingsTabRequest((current) => ({
          section: destination.settingsTab,
          requestId: current.requestId + 1,
        }));
      }
    });
  }, []);

  useEffect(() => {
    window.electronAPI?.analyticsNeedsConsent?.().then((needs: boolean) => {
      if (needs) setShowConsentModal(true);
    });
  }, []);

  useEffect(() => {
    if (activePage === "settings") {
      void trackAnalyticsEvent("settings_opened");
    }
  }, [activePage]);

  useEffect(() => {
    if (updateStatus.updateDownloaded && !isDownloading) {
      toast({
        title: "Update Ready",
        description: 'Choose "Restart and install" at the bottom of the sidebar to apply it.',
        variant: "success",
      });
    }
  }, [updateStatus.updateDownloaded, isDownloading, toast]);

  useEffect(() => {
    if (updateError) {
      toast({
        title: "Update Error",
        description: "Failed to update. Please try again later.",
        variant: "destructive",
      });
    }
  }, [updateError, toast]);

  // GPU→CPU transcription fallback: mirror the overlay notification so the
  // state change is visible from the control panel too.
  useEffect(() => {
    const unsubscribe = window.electronAPI?.onWhisperEngineFallbackChanged?.(
      (_event: unknown, data: { active?: boolean; recovered?: boolean; kind?: string }) => {
        if (data?.active) {
          // A Windows block is permanent until the user acts, so it must not
          // promise an automatic retry that will never succeed.
          const blockedByOs = data.kind === "blocked_by_os";
          toast({
            title: blockedByOs ? "Windows blocked the GPU engine" : "Transcribing on CPU",
            description: blockedByOs
              ? "Windows stopped the GPU engine from starting — usually Smart App Control or antivirus. Dictation continues on CPU, just slower. Updating PrivateTranscribe, or allowing the engine in your antivirus, restores GPU speed."
              : "The GPU engine could not start — this can happen during a graphics driver update. Dictation still works, just slower. The GPU will be retried automatically.",
            variant: "destructive",
            duration: 10000,
          });
        } else if (data?.recovered) {
          toast({
            title: "GPU transcription restored",
            description: "The graphics card is back in use for dictation.",
            variant: "success",
            duration: 5000,
          });
        }
      }
    );
    return () => unsubscribe?.();
  }, [toast]);

  const handleUpdateClick = async () => {
    if (updateStatus.updateDownloaded) {
      showConfirmDialog({
        title: "Install Update",
        description:
          "The update will be installed and the app will restart. Make sure you've saved any work.",
        onConfirm: async () => {
          try {
            await installUpdate();
          } catch (error) {
            toast({
              title: "Install Failed",
              description: "Failed to install update. Please try again.",
              variant: "destructive",
            });
          }
        },
      });
    } else if (updateStatus.updateAvailable && !isDownloading) {
      try {
        await downloadUpdate();
      } catch (error) {
        toast({
          title: "Download Failed",
          description: "Failed to download update. Please try again.",
          variant: "destructive",
        });
      }
    }
  };

  // The update notice lives in the sidebar footer beside the version marker,
  // so "which build am I running" and "a newer build exists" read as one thing
  // instead of putting a loud button next to the brand in the title bar.
  const renderUpdateNotice = () => {
    const hasUpdate =
      updateStatus.updateAvailable ||
      updateStatus.updateDownloaded ||
      isDownloading ||
      isInstalling;
    if (updateStatus.isDevelopment || !hasUpdate) {
      return null;
    }

    const isReady = updateStatus.updateDownloaded;
    const percent = Math.round(downloadProgress);

    let label = "Update available";
    if (isInstalling) label = "Restarting to install";
    else if (isDownloading) label = `Downloading ${percent}%`;
    else if (isReady) label = "Update ready to install";

    return (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "8px",
          padding: "10px",
          borderRadius: "8px",
          border: `1px solid ${isReady ? "rgba(112,255,186,0.25)" : "var(--color-border)"}`,
          backgroundColor: isReady ? "rgba(112,255,186,0.06)" : "var(--color-surface-2)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
          <span
            style={{
              width: "6px",
              height: "6px",
              borderRadius: "999px",
              flexShrink: 0,
              backgroundColor: isReady ? "var(--color-primary)" : "var(--color-foreground-muted)",
            }}
          />
          <span
            style={{
              fontSize: "11px",
              fontWeight: 600,
              color: isReady ? "var(--color-primary)" : "var(--color-foreground-muted)",
            }}
          >
            {label}
          </span>
          {updateInfo?.version && (
            <span
              style={{
                marginLeft: "auto",
                fontSize: "10px",
                fontFamily: "'JetBrains Mono', monospace",
                color: "var(--color-foreground-faint)",
              }}
            >
              v{updateInfo.version}
            </span>
          )}
        </div>

        {isDownloading && (
          <div
            style={{
              height: "3px",
              width: "100%",
              borderRadius: "999px",
              overflow: "hidden",
              backgroundColor: "var(--color-surface-raised)",
            }}
          >
            <div
              style={{
                height: "100%",
                width: `${Math.min(100, Math.max(0, percent))}%`,
                borderRadius: "999px",
                backgroundColor: "var(--color-primary)",
                transition: "width 200ms ease",
              }}
            />
          </div>
        )}

        {!isDownloading && !isInstalling && (
          <Button
            variant={isReady ? "default" : "outline"}
            size="sm"
            onClick={handleUpdateClick}
            className="w-full h-7 gap-1.5 text-[11px]"
          >
            {isReady ? <RefreshCw size={13} /> : <Download size={13} />}
            <span>{isReady ? "Restart and install" : "Download update"}</span>
          </Button>
        )}

        {isInstalling && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "6px",
              fontSize: "11px",
              color: "var(--color-foreground-faint)",
            }}
          >
            <Loader2 size={12} className="animate-spin" />
            <span>The app will reopen on its own</span>
          </div>
        )}
      </div>
    );
  };

  const renderPage = () => {
    switch (activePage) {
      case "home":
        return <DashboardPage onNavigate={setActivePage} />;
      case "history":
        return <HistoryPage />;
      case "transcribe":
        return <TranscribePage onOpenModelSettings={() => setActivePage("dictation")} />;
      case "dictation":
        return <DictationPage />;
      case "dictionary":
        return <DictionaryPage />;
      case "read-aloud":
        return <ReadAloudPage />;
      case "ai-enhancement":
        return <AIEnhancementPage />;
      case "converse":
        return <ConversePage />;
      case "correction-memory":
        return <DictionaryPage showCorrections />;
      case "action-engine":
        return <ActionEnginePage />;
      case "settings":
        return (
          <SettingsPageWrapper
            requestedSection={settingsTabRequest.section}
            requestId={settingsTabRequest.requestId}
            onNavigate={(page) => setActivePage(page as PageId)}
          />
        );
      default:
        return <DashboardPage onNavigate={setActivePage} />;
    }
  };

  return (
    <div
      style={{ display: "flex", flexDirection: "column", height: "100vh" }}
      className="bg-background"
    >
      <ConfirmDialog
        open={confirmDialog.open}
        onOpenChange={hideConfirmDialog}
        title={confirmDialog.title}
        description={confirmDialog.description}
        onConfirm={confirmDialog.onConfirm}
        variant={confirmDialog.variant}
      />

      <AlertDialog
        open={alertDialog.open}
        onOpenChange={hideAlertDialog}
        title={alertDialog.title}
        description={alertDialog.description}
        onOk={() => {}}
      />

      <TitleBar />

      <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
        <AppSidebar
          activePage={activePage === "correction-memory" ? "dictionary" : activePage}
          onPageChange={setActivePage}
          onOpenBetaFeatures={() => {
            setActivePage("settings");
            setSettingsTabRequest((current) => ({
              section: "beta",
              requestId: current.requestId + 1,
            }));
          }}
          updateSlot={renderUpdateNotice()}
        />

        <main ref={contentRef} style={{ flex: 1, overflowY: "auto", scrollbarGutter: "stable" }}>
          {renderPage()}
        </main>
      </div>

      {showConsentModal && <AnalyticsConsentModal onConsent={() => setShowConsentModal(false)} />}
    </div>
  );
}
