import { useState, useEffect } from "react";
import { Button } from "./ui/button";
import { Download, RefreshCw, Loader2 } from "lucide-react";
import AppSidebar, { PageId } from "./AppSidebar";
import TitleBar from "./TitleBar";
import { ConfirmDialog, AlertDialog } from "./ui/dialog";
import { useDialogs } from "../hooks/useDialogs";
import { useToast } from "./ui/Toast";
import { useUpdater } from "../hooks/useUpdater";

import DashboardPage from "./pages/DashboardPage";
import HistoryPage from "./pages/HistoryPage";
import TranscribePage from "./pages/TranscribePage";
import DictionaryPage from "./pages/DictionaryPage";
import AIEnhancementPage from "./pages/AIEnhancementPage";
import VoiceAssistantPage from "./pages/VoiceAssistantPage";
import ActionEnginePage from "./pages/ActionEnginePage";
import SettingsPageWrapper from "./pages/SettingsPageWrapper";

import { AnalyticsConsentModal } from "./AnalyticsConsentModal";

export default function ControlPanelShell() {
  const [activePage, setActivePage] = useState<PageId>("home");
  const [showConsentModal, setShowConsentModal] = useState(false);
  const { toast } = useToast();
  const { confirmDialog, alertDialog, showConfirmDialog, hideConfirmDialog, hideAlertDialog } =
    useDialogs();
  const {
    status: updateStatus,
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
      "dictionary",
      "ai-enhancement",
      "voice-assistant",
      "correction-memory",
      "action-engine",
      "settings",
    ];

    if (validPages.includes(requestedPage as PageId)) {
      setActivePage(
        requestedPage === "correction-memory" ? "dictionary" : (requestedPage as PageId)
      );
    }

    localStorage.removeItem("controlPanelInitialPage");
  }, []);

  useEffect(() => {
    window.electronAPI?.analyticsNeedsConsent?.().then((needs: boolean) => {
      if (needs) setShowConsentModal(true);
    });
  }, []);

  useEffect(() => {
    if (updateStatus.updateDownloaded && !isDownloading) {
      toast({
        title: "Update Ready",
        description: "Click 'Install Update' to restart and apply the update.",
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
      (_event: unknown, data: { active?: boolean; recovered?: boolean }) => {
        if (data?.active) {
          toast({
            title: "Transcribing on CPU",
            description:
              "The GPU engine could not start — this can happen during a graphics driver update. Dictation still works, just slower. The GPU will be retried automatically.",
            variant: "destructive",
            duration: 10000,
          });
        } else if (data?.recovered) {
          toast({
            title: "GPU transcription restored",
            description: "The CUDA engine started successfully and is back in use.",
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

  const getUpdateButtonContent = () => {
    if (isInstalling) {
      return (
        <>
          <Loader2 size={14} className="animate-spin" />
          <span>Installing...</span>
        </>
      );
    }
    if (isDownloading) {
      return (
        <>
          <Loader2 size={14} className="animate-spin" />
          <span>{Math.round(downloadProgress)}%</span>
        </>
      );
    }
    if (updateStatus.updateDownloaded) {
      return (
        <>
          <RefreshCw size={14} />
          <span>Install Update</span>
        </>
      );
    }
    if (updateStatus.updateAvailable) {
      return (
        <>
          <Download size={14} />
          <span>Update Available</span>
        </>
      );
    }
    return null;
  };

  const renderPage = () => {
    switch (activePage) {
      case "home":
        return <DashboardPage onNavigate={setActivePage} />;
      case "history":
        return <HistoryPage />;
      case "transcribe":
        return <TranscribePage />;
      case "dictionary":
        return <DictionaryPage />;
      case "ai-enhancement":
        return <AIEnhancementPage />;
      case "voice-assistant":
        return <VoiceAssistantPage />;
      case "correction-memory":
        return <DictionaryPage />;
      case "action-engine":
        return <ActionEnginePage />;
      case "settings":
        return <SettingsPageWrapper />;
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

      <TitleBar
        actions={
          <>
            {!updateStatus.isDevelopment &&
              (updateStatus.updateAvailable ||
                updateStatus.updateDownloaded ||
                isDownloading ||
                isInstalling) && (
                <Button
                  variant={updateStatus.updateDownloaded ? "default" : "outline"}
                  size="sm"
                  onClick={handleUpdateClick}
                  disabled={isInstalling || isDownloading}
                  className="gap-1.5 text-xs"
                >
                  {getUpdateButtonContent()}
                </Button>
              )}
          </>
        }
      />

      <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
        <AppSidebar activePage={activePage} onPageChange={setActivePage} />

        <main style={{ flex: 1, overflowY: "auto", scrollbarGutter: "stable" }}>
          {renderPage()}
        </main>
      </div>

      {showConsentModal && <AnalyticsConsentModal onConsent={() => setShowConsentModal(false)} />}
    </div>
  );
}
