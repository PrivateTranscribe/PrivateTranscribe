/**
 * PrivateTranscribe Pro Licensing Client
 *
 * Handles license activation, validation, and entitlement caching.
 * Privacy-first: device IDs are hashed, minimal data sent to server.
 */

const LICENSING_BASE_URL =
  import.meta.env.VITE_LICENSING_BASE_URL ||
  "https://wsfrykhacxjfsgvqnlbq.supabase.co/functions/v1";

// Storage keys
const STORAGE_LICENSE_KEY = "privatetranscribe_license_key";
const STORAGE_ENTITLEMENT = "privatetranscribe_entitlement";
const STORAGE_PRO_STATUS = "privatetranscribe_pro_status";

// Internal integrity - scattered validation markers
const _SEAL_KEY = "privatetranscribe_seal";
const _EPOCH_KEY = "privatetranscribe_ts";

/**
 * Simple hash for integrity checks (not crypto-grade, just tamper detection)
 */
function _computeSeal(data: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < data.length; i++) {
    h ^= data.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

function _writeSeal(key: string, entitlement: string): void {
  const raw = key + "|" + entitlement + "|" + navigator.userAgent.slice(0, 20);
  localStorage.setItem(_SEAL_KEY, _computeSeal(raw));
  localStorage.setItem(_EPOCH_KEY, String(Date.now()));
}

function _verifySeal(): boolean {
  const key = localStorage.getItem(STORAGE_LICENSE_KEY);
  const ent = localStorage.getItem(STORAGE_ENTITLEMENT);
  const seal = localStorage.getItem(_SEAL_KEY);
  if (!key || !ent || !seal) return false;
  const raw = key + "|" + ent + "|" + navigator.userAgent.slice(0, 20);
  return _computeSeal(raw) === seal;
}

/** Remove all locally cached license/entitlement data. */
function _clearLicenseData(): void {
  localStorage.removeItem(STORAGE_LICENSE_KEY);
  localStorage.removeItem(STORAGE_ENTITLEMENT);
  localStorage.removeItem(STORAGE_PRO_STATUS);
  localStorage.removeItem(_SEAL_KEY);
  localStorage.removeItem(_EPOCH_KEY);
}

/**
 * Generate a stable, privacy-preserving device ID.
 * Uses a hash of machine-specific properties (not PII).
 */
async function getDeviceId(): Promise<string> {
  try {
    const result = await window.electronAPI?.getMachineId?.();
    if (result?.id) return result.id;
  } catch {
    // fallback
  }

  // Fallback: generate a random ID and persist it
  let deviceId = localStorage.getItem("privatetranscribe_device_id");
  if (!deviceId) {
    deviceId = crypto.randomUUID();
    localStorage.setItem("privatetranscribe_device_id", deviceId);
  }
  return deviceId;
}

function getDeviceName(): string {
  try {
    return navigator.userAgent.includes("Windows")
      ? "Windows PC"
      : navigator.userAgent.includes("Mac")
        ? "Mac"
        : "Desktop";
  } catch {
    return "Desktop";
  }
}

export interface ProStatus {
  isPro: boolean;
  licenseKey: string | null;
  expiresAt: string | null;
  offlineGrace: boolean;
  error: string | null;
  /** @internal opaque validation token - do not rely on externally */
  _t?: number;
}

/**
 * Internal: produce a validation token that scattered checks can verify.
 * This is NOT security - it's annoyance for casual patchers.
 */
function _proToken(isPro: boolean): number {
  // Encode pro status + timestamp into a non-obvious number
  const ts = Math.floor(Date.now() / 60000); // minute-granularity
  return isPro ? ts * 7 + 42 : 0;
}

export function _verifyToken(t: number | undefined): boolean {
  if (!t || t === 0) return false;
  const ts = Math.floor(Date.now() / 60000);
  // Allow 30 min drift
  const decoded = (t - 42) / 7;
  return Math.abs(decoded - ts) < 30;
}

/**
 * Get the current Pro status from local cache.
 * Does NOT call the server - use refreshProStatus() for that.
 */
export function getProStatus(): ProStatus {
  const key = localStorage.getItem(STORAGE_LICENSE_KEY);
  const entitlementRaw = localStorage.getItem(STORAGE_ENTITLEMENT);

  if (!key || !entitlementRaw) {
    return {
      isPro: false,
      licenseKey: null,
      expiresAt: null,
      offlineGrace: false,
      error: null,
      _t: 0,
    };
  }

  // Integrity check: if seal doesn't match, entitlement may have been tampered with
  if (!_verifySeal()) {
    return {
      isPro: false,
      licenseKey: key,
      expiresAt: null,
      offlineGrace: false,
      error: "License data integrity check failed - please re-activate",
      _t: 0,
    };
  }

  try {
    const entitlement = JSON.parse(entitlementRaw);
    const expiresAt = entitlement.expiresAt ?? null;

    // A one-time license never expires from the user's side. `expiresAt` is only
    // a hint for when the app should next try to re-validate online (to pick up
    // refunds / revocations). An old or past `expiresAt` — e.g. because the user
    // has been offline — must NOT downgrade a paying customer. Revocation happens
    // exclusively via an explicit server response during online re-validation
    // (see refreshProStatus), never from local time.
    return {
      isPro: true,
      licenseKey: key,
      expiresAt,
      offlineGrace: false,
      error: null,
      _t: _proToken(true),
    };
  } catch {
    return {
      isPro: false,
      licenseKey: key,
      expiresAt: null,
      offlineGrace: false,
      error: "Invalid entitlement data",
      _t: 0,
    };
  }
}

/**
 * Activate a license key. Calls the server, caches the entitlement locally.
 */
export async function activateLicense(key: string): Promise<{
  success: boolean;
  error?: string;
  /** True when the server was reached (vs. a network/connection failure). */
  reachedServer?: boolean;
  /** True when the server explicitly reports the license is no longer valid. */
  revoked?: boolean;
  devices?: Array<{ deviceId: string; deviceName: string; activatedAt: string }>;
}> {
  const deviceId = await getDeviceId();
  const deviceName = getDeviceName();

  try {
    const res = await fetch(`${LICENSING_BASE_URL}/activate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: key.trim().toUpperCase(), deviceId, deviceName }),
    });

    let data: any = {};
    try {
      data = await res.json();
    } catch {
      // Non-JSON response (e.g. gateway error). Treat as reachable-but-failed,
      // NOT as a revoke — we have no explicit revoke signal.
      data = {};
    }

    if (!data.success) {
      return {
        success: false,
        error: data.error,
        devices: data.devices,
        reachedServer: true,
        // Only the server may declare a license dead. It sets `revoked: true`
        // for refunded / disabled / non-existent keys.
        revoked: data.revoked === true,
      };
    }

    // Cache locally
    const normalizedKey = key.trim().toUpperCase();
    const entitlementStr = JSON.stringify(data.entitlement);
    localStorage.setItem(STORAGE_LICENSE_KEY, normalizedKey);
    localStorage.setItem(STORAGE_ENTITLEMENT, entitlementStr);
    localStorage.setItem(STORAGE_PRO_STATUS, "active");
    _writeSeal(normalizedKey, entitlementStr);

    return { success: true, reachedServer: true };
  } catch (err: any) {
    // Network/connection failure — server was never reached.
    return {
      success: false,
      reachedServer: false,
      error: "Could not connect to licensing server. Check your internet connection.",
    };
  }
}

/**
 * Deactivate the current device.
 */
export async function deactivateDevice(): Promise<{ success: boolean; error?: string }> {
  const key = localStorage.getItem(STORAGE_LICENSE_KEY);
  const deviceId = await getDeviceId();

  if (!key) {
    return { success: false, error: "No license key found" };
  }

  try {
    const res = await fetch(`${LICENSING_BASE_URL}/deactivate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key, deviceId }),
    });

    const data = await res.json();

    if (data.success) {
      _clearLicenseData();
    }

    return data;
  } catch {
    return { success: false, error: "Could not connect to licensing server" };
  }
}

/**
 * Re-validate the cached entitlement with the server.
 *
 * Called on app start (and manually via the Pro settings "Validate" button).
 * This is the ONLY place a previously-activated license can be downgraded, and
 * only when the server is reachable AND explicitly reports the license as no
 * longer valid (refund / chargeback / disabled key). Being offline, a network
 * error, or any other transient failure never removes Pro — a paying customer
 * who stays offline keeps Pro indefinitely (they simply stop receiving updates).
 */
export async function refreshProStatus(): Promise<ProStatus> {
  const key = localStorage.getItem(STORAGE_LICENSE_KEY);
  if (!key) {
    return getProStatus();
  }

  // Try to re-activate (which refreshes the entitlement token)
  const result = await activateLicense(key);

  if (result.success) {
    return getProStatus();
  }

  // The server was reached and explicitly revoked this license. Downgrade now.
  if (result.reachedServer && result.revoked) {
    _clearLicenseData();
    return {
      isPro: false,
      licenseKey: key,
      expiresAt: null,
      offlineGrace: false,
      error: result.error || "This license is no longer active.",
      _t: 0,
    };
  }

  // Any other outcome — offline, network error, or a non-revoke server response
  // (e.g. a transient 5xx or a device-limit reply during refresh) — must keep
  // the paying customer on Pro using the cached entitlement.
  const cached = getProStatus();
  if (cached.isPro) {
    return { ...cached, offlineGrace: true };
  }

  return {
    isPro: false,
    licenseKey: key,
    expiresAt: null,
    offlineGrace: false,
    error: result.error || "Could not validate license",
    _t: 0,
  };
}

/**
 * Whether the licensing backend is configured and ready to accept activations.
 * Returns false when LICENSING_BASE_URL is not yet set (pre-launch / dev builds).
 */
export function isLicensingConfigured(): boolean {
  return LICENSING_BASE_URL.length > 0;
}
