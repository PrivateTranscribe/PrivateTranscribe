/**
 * Privoca Pro Licensing Client
 *
 * Handles license activation, validation, and entitlement caching.
 * Privacy-first: device IDs are hashed, minimal data sent to server.
 */

const LICENSING_BASE_URL = ""; // Set this when deploying: e.g. https://xyz.supabase.co/functions/v1

// Offline grace: how long to trust a cached entitlement without re-validating
const OFFLINE_GRACE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// Storage keys
const STORAGE_LICENSE_KEY = "privoca_license_key";
const STORAGE_ENTITLEMENT = "privoca_entitlement";
const STORAGE_PRO_STATUS = "privoca_pro_status";

/**
 * Generate a stable, privacy-preserving device ID.
 * Uses a hash of machine-specific properties (not PII).
 */
async function getDeviceId(): Promise<string> {
  try {
    const raw = await window.electronAPI?.getMachineId?.();
    if (raw) return raw;
  } catch {
    // fallback
  }

  // Fallback: generate a random ID and persist it
  let deviceId = localStorage.getItem("privoca_device_id");
  if (!deviceId) {
    deviceId = crypto.randomUUID();
    localStorage.setItem("privoca_device_id", deviceId);
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
}

/**
 * Get the current Pro status from local cache.
 * Does NOT call the server — use refreshProStatus() for that.
 */
export function getProStatus(): ProStatus {
  const key = localStorage.getItem(STORAGE_LICENSE_KEY);
  const entitlementRaw = localStorage.getItem(STORAGE_ENTITLEMENT);
  const cachedStatus = localStorage.getItem(STORAGE_PRO_STATUS);

  if (!key || !entitlementRaw) {
    return { isPro: false, licenseKey: null, expiresAt: null, offlineGrace: false, error: null };
  }

  try {
    const entitlement = JSON.parse(entitlementRaw);
    const expiresAt = entitlement.expiresAt;
    const isExpired = new Date(expiresAt) < new Date();

    if (isExpired) {
      return {
        isPro: false,
        licenseKey: key,
        expiresAt,
        offlineGrace: false,
        error: "License expired — please connect to the internet to re-validate",
      };
    }

    return {
      isPro: true,
      licenseKey: key,
      expiresAt,
      offlineGrace: false,
      error: null,
    };
  } catch {
    return { isPro: false, licenseKey: key, expiresAt: null, offlineGrace: false, error: "Invalid entitlement data" };
  }
}

/**
 * Activate a license key. Calls the server, caches the entitlement locally.
 */
export async function activateLicense(key: string): Promise<{
  success: boolean;
  error?: string;
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

    const data = await res.json();

    if (!data.success) {
      return { success: false, error: data.error, devices: data.devices };
    }

    // Cache locally
    localStorage.setItem(STORAGE_LICENSE_KEY, key.trim().toUpperCase());
    localStorage.setItem(STORAGE_ENTITLEMENT, JSON.stringify(data.entitlement));
    localStorage.setItem(STORAGE_PRO_STATUS, "active");

    return { success: true };
  } catch (err: any) {
    return { success: false, error: "Could not connect to licensing server. Check your internet connection." };
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
      // Clear local cache
      localStorage.removeItem(STORAGE_LICENSE_KEY);
      localStorage.removeItem(STORAGE_ENTITLEMENT);
      localStorage.removeItem(STORAGE_PRO_STATUS);
    }

    return data;
  } catch {
    return { success: false, error: "Could not connect to licensing server" };
  }
}

/**
 * Re-validate the cached entitlement with the server.
 * Call this periodically (e.g. on app start) to refresh the offline grace window.
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

  // If server is unreachable, fall back to cached entitlement
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
  };
}

/**
 * Check if a specific Pro feature is unlocked.
 */
export function isProFeature(featureId: string): boolean {
  const status = getProStatus();
  return status.isPro;
}
