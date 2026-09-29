import React, { useState, useEffect } from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";
import ControlPanelShell from "./components/ControlPanelShell.tsx";
import OnboardingFlow from "./components/OnboardingFlow.tsx";
import { AnalyticsConsentModal } from "./components/AnalyticsConsentModal.jsx";
import { ToastProvider } from "./components/ui/Toast.tsx";
import { ErrorBoundary } from "./components/ErrorBoundary.tsx";
import { useTheme } from "./hooks/useTheme";
import { trackAnalyticsEventOnce } from "./utils/analytics.ts";
import { applyStoredHotkeyMigrations } from "./utils/hotkeys.ts";
import { cleanUpLegacyPlanState } from "./utils/legacyPlanCleanup.ts";
import "./index.css";

// Repair stored hotkeys before anything reads them. useSettings persists its
// default on first read, so a migration that ran after mount would be writing
// underneath a value the app had already adopted.
applyStoredHotkeyMigrations();

// Same reason: the beta switch is read on first render, so a former tester's
// switch has to be on before then.
cleanUpLegacyPlanState();

// Tell the main process the window now has real content on it.
//
// Electron's own `ready-to-show` fires at the first composited frame, which for
// a React SPA is the empty <div id="root"> — showing on it is what produced a
// blank window while the bundle was still booting. Two nested rAFs put this
// after the commit that actually drew the first screen: the first fires before
// that paint, the second after it.
let paintedNotified = false;
function notifyPaintedOnce() {
  if (paintedNotified) return;
  paintedNotified = true;
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      window.electronAPI?.notifyRendererPainted?.();
    });
  });
}

// eslint-disable-next-line react-refresh/only-export-components
function AppRouter() {
  // Initialize theme system
  useTheme();

  const [showOnboarding, setShowOnboarding] = useState(false);
  const [showAnalyticsConsent, setShowAnalyticsConsent] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  // Check if this is the control panel window
  const isControlPanel =
    window.location.pathname.includes("control") || window.location.search.includes("panel=true");

  // Check if this is the dictation panel (main app)
  const isDictationPanel = !isControlPanel;

  useEffect(() => {
    // Check if onboarding has been completed
    const onboardingCompleted = localStorage.getItem("onboardingCompleted") === "true";
    // Clamp step to valid range (0-5) for current 6-step onboarding
    const rawStep = parseInt(localStorage.getItem("onboardingCurrentStep") || "0");
    const currentStep = Math.max(0, Math.min(rawStep, 5));

    if (isControlPanel && !onboardingCompleted) {
      // Show onboarding for control panel if not completed
      setShowOnboarding(true);
      window.electronAPI?.analyticsNeedsConsent?.().then((needs) => {
        if (needs) setShowAnalyticsConsent(true);
      });
    }

    // Hide dictation panel window unless onboarding is complete or we're past the permissions step
    if (isDictationPanel && !onboardingCompleted && currentStep < 4) {
      window.electronAPI?.hideWindow?.();
    }

    setIsLoading(false);
  }, [isControlPanel, isDictationPanel]);

  useEffect(() => {
    if (isControlPanel && showOnboarding) {
      void trackAnalyticsEventOnce("onboarding_started", { step_count: 6 });
    }
  }, [isControlPanel, showOnboarding]);

  // The loading spinner is not "real content" — releasing the window on it would
  // just move the blank frame one step later. Wait for the branch that renders
  // the actual surface.
  useEffect(() => {
    if (!isLoading) {
      notifyPaintedOnce();
    }
  }, [isLoading]);

  const handleOnboardingComplete = () => {
    setShowOnboarding(false);
    localStorage.setItem("onboardingCompleted", "true");
  };

  const handleAnalyticsConsent = (granted) => {
    setShowAnalyticsConsent(false);
    if (granted && isControlPanel && showOnboarding) {
      const rawStep = parseInt(localStorage.getItem("onboardingCurrentStep") || "0", 10);
      const currentStep = Number.isFinite(rawStep) ? Math.max(0, Math.min(rawStep, 5)) : 0;
      void trackAnalyticsEventOnce("onboarding_started", { step_count: 6 });
      void window.electronAPI?.analyticsTrack?.("onboarding_step_viewed", {
        step: currentStep + 1,
        step_count: 6,
      });
    }
  };

  if (isLoading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary mx-auto mb-4"></div>
          <p className="text-muted-foreground">Loading PrivateTranscribe...</p>
        </div>
      </div>
    );
  }

  if (isControlPanel && showOnboarding) {
    return (
      <>
        <OnboardingFlow onComplete={handleOnboardingComplete} />
        {showAnalyticsConsent && <AnalyticsConsentModal onConsent={handleAnalyticsConsent} />}
      </>
    );
  }

  // Only apply grain overlay on control panel, not dictation window (transparent bg)
  if (isControlPanel) {
    return (
      <div className="grain-overlay">
        <ControlPanelShell />
      </div>
    );
  }

  return <App />;
}

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <ErrorBoundary>
      <ToastProvider>
        <AppRouter />
      </ToastProvider>
    </ErrorBoundary>
  </React.StrictMode>
);
