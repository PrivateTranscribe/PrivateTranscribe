/**
 * Opens a URL in the user's default system browser (not inside Electron window)
 */
export function openExternalLink(url: string): void {
  if (window.electronAPI?.openExternal) {
    window.electronAPI.openExternal(url);
  } else {
    // Fallback for non-Electron environments (development, etc.)
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

/**
 * Returns an onClick handler that opens a URL in the default browser
 * Prevents default link behavior to avoid opening in Electron window
 */
export function createExternalLinkHandler(url: string) {
  return (e: React.MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault();
    openExternalLink(url);
  };
}

/**
 * Where the app sends someone who wants a locked beta feature.
 *
 * The site has no dedicated /beta route. The tester section lives on the
 * homepage under #waitlist, which holds the "Apply for early Beta access"
 * button and the signup form, and carries scroll-mt so a deep link lands on
 * it rather than under the nav. Verified against the live site.
 *
 * Defined once so moving it to a real page later is a one-line change rather
 * than a hunt through six locked surfaces.
 */
export const BETA_ACCESS_URL = "https://privatetranscribe.com/#waitlist";
