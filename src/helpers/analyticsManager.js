const { app } = require("electron");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const debugLogger = require("./debugLogger");
const { isAllowedAnalyticsEvent, sanitizeAnalyticsProperties } = require("./analyticsPayload");
const { OFFICIAL_BUILD_FIELD, isOfficialBuild } = require("./officialBuild");

const SUPABASE_URL = "https://wsfrykhacxjfsgvqnlbq.supabase.co";
// Publishable key - safe to embed. Supabase RLS / Edge Function auth decides what it can do.
const SUPABASE_ANON_KEY = "sb_publishable_QN2jW34xQsNcVBT9Q76HNw_Yyo8gnao";
const DEVICE_ID_FILE = "device-id.txt";
const CONSENT_FILE = "analytics-consent.txt";
const CONSENT_VERSION = 2;
const UNOFFICIAL_BUILD = "unofficial-build";

class AnalyticsManager {
  constructor() {
    this._deviceId = null;
    this._consent = null; // null = not decided yet
    this._supabaseAnonKey = SUPABASE_ANON_KEY;
    this._officialBuild = null;
  }

  initialize(supabaseAnonKey) {
    // Key is hardcoded (publishable, safe to embed); param kept for backward compatibility.
    this._supabaseAnonKey = supabaseAnonKey || SUPABASE_ANON_KEY;
    // A copy built from source can share userData with the installed app, so it
    // must not read, act on, or rewrite that install's consent file.
    if (!this._isOfficialBuild()) {
      debugLogger.info(
        `Analytics off: package.json has no ${OFFICIAL_BUILD_FIELD} flag, so this copy was built from source`
      );
      return;
    }
    this._consent = this._loadConsent();
    if (this._consent === "granted") {
      this._deviceId = this._getOrCreateDeviceId();
    }
    debugLogger.info("AnalyticsManager initialized", { consent: this._consent });
  }

  needsConsentPrompt() {
    return this._isOfficialBuild() && this._consent === null;
  }

  getConsentStatus() {
    return this._consent;
  }

  setConsent(granted) {
    if (!this._isOfficialBuild()) {
      return { saved: false, reason: UNOFFICIAL_BUILD };
    }
    const previousConsent = this._consent;
    this._consent = granted ? "granted" : "denied";
    this._saveConsent(this._consent);
    if (granted) {
      this._deviceId = this._getOrCreateDeviceId();
    }
    debugLogger.info("Analytics consent set", { granted });

    // The normal startup event fires before a first-run user has seen the consent prompt.
    // Record this launch after consent so the top of the activation funnel is not lost.
    if (granted && previousConsent !== "granted") {
      this.track("app_launched", { launch_context: "consent_granted" }).catch(() => {});
      return { saved: true };
    }

    return { saved: true };
  }

  // Fire and forget - never throws.
  async track(event, properties = {}) {
    if (!this._isOfficialBuild()) {
      return { sent: false, reason: UNOFFICIAL_BUILD };
    }
    if (this._consent !== "granted") {
      return { sent: false, reason: "consent-not-granted" };
    }
    if (!this._supabaseAnonKey) {
      return { sent: false, reason: "missing-key" };
    }
    if (!isAllowedAnalyticsEvent(event)) {
      debugLogger.warn("Analytics event rejected by allowlist", { event });
      return { sent: false, reason: "invalid-event" };
    }

    try {
      const payload = {
        device_id: this._deviceId,
        event,
        app_version: app?.getVersion?.() || "unknown",
        os: process.platform,
        properties: sanitizeAnalyticsProperties(properties),
      };
      const response = await fetch(`${SUPABASE_URL}/rest/v1/usage_events`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: this._supabaseAnonKey,
          Authorization: `Bearer ${this._supabaseAnonKey}`,
          Prefer: "return=minimal",
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        debugLogger.warn("Analytics track rejected by backend", {
          event,
          status: response.status,
        });
        return { sent: false, reason: `http-${response.status}` };
      }

      return { sent: true };
    } catch (err) {
      debugLogger.warn("Analytics track failed (non-fatal)", { event, err: err.message });
      return { sent: false, reason: "network-error" };
    }
  }

  getDeviceIdForExplicitFeedback() {
    // Feedback is user-initiated, so this does not require analytics consent.
    // The server hashes/rate-limits this random per-install ID; it is not an email or hardware ID.
    this._deviceId = this._deviceId || this._getOrCreateDeviceId();
    return this._deviceId;
  }

  getSupabaseConfig() {
    return {
      url: SUPABASE_URL,
      anonKey: this._supabaseAnonKey || SUPABASE_ANON_KEY,
    };
  }

  // Cached because track() runs on every dictation; the answer cannot change at runtime.
  _isOfficialBuild() {
    if (this._officialBuild === null) {
      this._officialBuild = isOfficialBuild();
    }
    return this._officialBuild;
  }

  _getOrCreateDeviceId() {
    try {
      const userDataPath = app?.getPath?.("userData") || "";
      const idFile = path.join(userDataPath, DEVICE_ID_FILE);
      if (fs.existsSync(idFile)) {
        return fs.readFileSync(idFile, "utf8").trim();
      }
      const newId = crypto.randomUUID();
      fs.writeFileSync(idFile, newId, "utf8");
      return newId;
    } catch {
      return crypto.randomUUID(); // ephemeral fallback
    }
  }

  _loadConsent() {
    try {
      const userDataPath = app?.getPath?.("userData") || "";
      const consentFile = path.join(userDataPath, CONSENT_FILE);
      if (fs.existsSync(consentFile)) {
        const storedConsent = fs.readFileSync(consentFile, "utf8").trim();
        if (storedConsent === `granted:v${CONSENT_VERSION}`) {
          return "granted";
        }
        if (storedConsent === `denied:v${CONSENT_VERSION}` || storedConsent === "denied") {
          return "denied";
        }
        // A previous grant covered fewer telemetry dimensions. Pause analytics
        // until the expanded disclosure has been shown and accepted.
        return null;
      }
    } catch {}
    return null;
  }

  _saveConsent(value) {
    try {
      const userDataPath = app?.getPath?.("userData") || "";
      const consentFile = path.join(userDataPath, CONSENT_FILE);
      fs.writeFileSync(consentFile, `${value}:v${CONSENT_VERSION}`, "utf8");
    } catch {}
  }
}

module.exports = new AnalyticsManager();
