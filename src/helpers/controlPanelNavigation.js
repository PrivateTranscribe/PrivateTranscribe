const VALID_CONTROL_PANEL_PAGES = new Set([
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
]);

const VALID_SETTINGS_TABS = new Set([
  "general",
  "preferences",
  "permissions",
  "pro",
  "help",
  "developer",
]);

/**
 * Keep renderer-provided navigation values inside the control panel's known routes.
 * Settings tabs only apply when the destination is the settings page.
 */
function normalizeControlPanelDestination(destination) {
  if (!destination || typeof destination !== "object") {
    return null;
  }

  const page = VALID_CONTROL_PANEL_PAGES.has(destination.page) ? destination.page : undefined;
  if (!page) {
    return null;
  }

  const settingsTab =
    page === "settings" && VALID_SETTINGS_TABS.has(destination.settingsTab)
      ? destination.settingsTab
      : undefined;

  return settingsTab ? { page, settingsTab } : { page };
}

module.exports = {
  normalizeControlPanelDestination,
};
