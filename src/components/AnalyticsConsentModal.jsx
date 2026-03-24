import React from "react";

export function AnalyticsConsentModal({ onConsent }) {
  const handleConsent = async (granted) => {
    await window.electronAPI?.analyticsSetConsent?.(granted);
    onConsent(granted);
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 9999,
        backgroundColor: "rgba(0,0,0,0.6)",
      }}
    >
      <div
        style={{
          backgroundColor: "#0f0f0f",
          border: "1px solid rgba(255,255,255,0.1)",
          borderRadius: "1rem",
          padding: "1.5rem",
          maxWidth: "24rem",
          width: "100%",
        }}
      >
        <p
          style={{
            fontSize: "0.75rem",
            fontWeight: 600,
            color: "#70FFBA",
            marginBottom: "0.5rem",
          }}
        >
          PrivateTranscribe
        </p>
        <h2
          style={{
            fontSize: "1rem",
            fontWeight: 600,
            color: "#ffffff",
            marginBottom: "0.75rem",
          }}
        >
          Help improve PrivateTranscribe
        </h2>
        <p
          style={{
            fontSize: "0.875rem",
            color: "rgba(255,255,255,0.65)",
            lineHeight: 1.5,
            marginBottom: "1.25rem",
          }}
        >
          Help make PrivateTranscribe better — send anonymous crash reports and feature usage
          counts. No audio, no text, ever. You can change this anytime in settings.
        </p>
        <div style={{ display: "flex", gap: "0.75rem" }}>
          <button
            onClick={() => handleConsent(false)}
            style={{
              flex: 1,
              padding: "0.5rem 1rem",
              borderRadius: "0.5rem",
              border: "1px solid rgba(255,255,255,0.2)",
              backgroundColor: "transparent",
              color: "rgba(255,255,255,0.6)",
              fontSize: "0.875rem",
              cursor: "pointer",
            }}
          >
            No thanks
          </button>
          <button
            onClick={() => handleConsent(true)}
            style={{
              flex: 1,
              padding: "0.5rem 1rem",
              borderRadius: "0.5rem",
              border: "none",
              backgroundColor: "#70FFBA",
              color: "#000000",
              fontSize: "0.875rem",
              fontWeight: 500,
              cursor: "pointer",
            }}
          >
            Yes, help out
          </button>
        </div>
      </div>
    </div>
  );
}
