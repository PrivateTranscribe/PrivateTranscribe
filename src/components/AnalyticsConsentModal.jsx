import React, { useState } from "react";

export function AnalyticsConsentModal({ onConsent }) {
  const [noHover, setNoHover] = useState(false);
  const [yesHover, setYesHover] = useState(false);

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
          Share anonymous setup milestones and feature usage counts. PrivateTranscribe never sends
          audio, transcripts, window titles, filenames, or API keys. You can change this anytime in
          Settings.
        </p>
        <div style={{ display: "flex", gap: "0.75rem" }}>
          <button
            onClick={() => handleConsent(false)}
            onMouseEnter={() => setNoHover(true)}
            onMouseLeave={() => setNoHover(false)}
            style={{
              flex: 1,
              padding: "0.5rem 1rem",
              borderRadius: "0.5rem",
              border: `1px solid ${noHover ? "rgba(255,255,255,0.35)" : "rgba(255,255,255,0.2)"}`,
              backgroundColor: noHover ? "rgba(255,255,255,0.06)" : "transparent",
              color: noHover ? "rgba(255,255,255,0.85)" : "rgba(255,255,255,0.6)",
              fontSize: "0.875rem",
              cursor: "pointer",
              transition: "all 200ms ease",
            }}
          >
            No thanks
          </button>
          <button
            onClick={() => handleConsent(true)}
            onMouseEnter={() => setYesHover(true)}
            onMouseLeave={() => setYesHover(false)}
            style={{
              flex: 1,
              padding: "0.5rem 1rem",
              borderRadius: "0.5rem",
              border: "none",
              backgroundColor: yesHover ? "#8FFFCA" : "#70FFBA",
              color: "#000000",
              fontSize: "0.875rem",
              fontWeight: 500,
              cursor: "pointer",
              transition: "all 200ms ease",
            }}
          >
            Yes, help out
          </button>
        </div>
      </div>
    </div>
  );
}
