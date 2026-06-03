const { app } = require("electron");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const debugLogger = require("./debugLogger");

const SUPABASE_URL = "https://wsfrykhacxjfsgvqnlbq.supabase.co";
// Publishable key — safe to embed. Supabase RLS / Edge Function auth decides what it can do.
const SUPABASE_ANON_KEY = "sb_publishable_QN2jW34xQsNcVBT9Q76HNw_Yyo8gnao";
const DEVICE_ID_FILE = "device-id.txt";
const CONSENT_FILE = "analytics-consent.txt";

class AnalyticsManager {
  constructor() {
    this._deviceId = null;
    this._consent = null; // null = not decided yet
    this._supabaseAnonKey = SUPABASE_ANON_KEY;
  }

  initialize(supabaseAnonKey) {
    // Key is hardcoded (publishable, safe to embed); param kept for backward compat
    this._supabaseAnonKey = supabaseAnonKey || SUPABASE_ANON_KEY;
    this._consent = this._loadConsent();
    if (this._consent === "granted") {
      this._deviceId = this._getOrCreateDeviceId();
    }
    debugLogger.info("AnalyticsManager initialized", { consent: this._consent });
  }

  // Returns true if consent has not been asked yet
  needsConsentPrompt() {
    return this._consent === null;
  }

  setConsent(granted) {
    this._consent = granted ? "granted" : "denied";
    this._saveConsent(this._consent);
    if (granted) {
      this._deviceId = this._getOrCreateDeviceId();
    }
    debugLogger.info("Analytics consent set", { granted });
  }

  // Fire and forget — never throws
  async track(event, extra = {}) {
    if (this._consent !== "granted") return;
    if (!this._supabaseAnonKey) return;
    try {
      const payload = {
        device_id: this._deviceId,
        event,
        app_version: app?.getVersion?.() || "unknown",
        os: process.platform,
        ...extra,
      };
      await fetch(`${SUPABASE_URL}/rest/v1/usage_events`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: this._supabaseAnonKey,
          Authorization: `Bearer ${this._supabaseAnonKey}`,
          Prefer: "return=minimal",
        },
        body: JSON.stringify(payload),
      });
    } catch (err) {
      debugLogger.warn("Analytics track failed (non-fatal)", { event, err: err.message });
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
        return fs.readFileSync(consentFile, "utf8").trim();
      }
    } catch {}
    return null;
  }

  _saveConsent(value) {
    try {
      const userDataPath = app?.getPath?.("userData") || "";
      const consentFile = path.join(userDataPath, CONSENT_FILE);
      fs.writeFileSync(consentFile, value, "utf8");
    } catch {}
  }
}

module.exports = new AnalyticsManager();
