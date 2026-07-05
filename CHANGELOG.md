# Changelog

## 0.13.1 - 2026-07-05

### Added

- Published CUDA engine update path for v0.0.9 so newer GPU packages can be surfaced to installed apps.
- Added Starter daily word cap behavior with 5,000 private words per day.

### Changed

- Merged latest main changes into production for the next Windows release.

### Fixed

- Fixed overlay drag/taskbar snapping hardening and wake-from-sleep audio cleanup included from main.

## 0.13.0 - 2026-06-24

### Added

- Added manual tester approval flow with Discord Approve and Deny buttons so signup requests can be reviewed before access is granted.
- Added name and use-case fields to the tester signup form so applicants can introduce themselves and their intended use.
- Added license key delivery by email on approval so approved testers receive their Pro key automatically.

### Changed

- Reworked tester signup to send Discord approval requests immediately on form submission instead of requiring email confirmation first.
- Enriched Discord signup notifications with name, use case, OS, and source for better context.
- Aligned all email templates with the brand writing style and removed personal names from user-facing copy.

### Fixed

- Fixed Discord webhook buttons not appearing by enabling component support on the webhook payload.
- Fixed email send failures being silently swallowed instead of reported in the approval flow.
- Fixed taskbar snap defaulting to off on fresh installs.

## 0.12.2 - 2026-06-23

### Added

- Added screenshot attachments to in-app feedback so testers can paste or add images.
- Added Discord forwarding with screenshot links and image previews so feedback arrives in one place.
- Added paste-to-attach (Ctrl+V) in the feedback dialog for faster screenshot sharing.

### Changed

- Differentiated Discord feedback category colors so feature ideas and general feedback no longer look the same.
- Reduced GitHub Actions artifact retention to avoid hitting storage limits.
- Feedback now always includes app version and system info with a clear privacy notice instead of an opt-in checkbox.

## 0.12.1 - 2026-06-22

### Fixed

- Improved Windows uninstall cleanup so manual uninstall can remove app data and model caches without affecting updater installs.
- Prevented uninstall cleanup prompts from appearing during app updates or silent uninstalls.

## 0.12.0 - 2026-06-22

### Added

- Added dictionary modes so words can be saved as hints, exact spelling repairs, or higher-priority terms.
- Added correction-memory improvements that keep learned repairs focused on useful word-level corrections.
- Added reusable PrivateTranscribe email templates for early access and license emails.

### Changed

- Merged correction memory into the dictionary page so vocabulary and learned fixes live together.
- Improved dictionary mode explanations, dropdown styling, chip hover states, and selected-item colors to match the app theme.
- Aligned app, website, and email copy with the current writing style.

### Fixed

- Enforced Pro licensing in production builds so development preview overrides cannot unlock paid features.
- Validated Whisper model files before use so broken or partial model downloads are not treated as ready.
- Uploaded Windows updater blockmaps before release metadata so updater artifacts are complete.
- Hardened email backgrounds and logo rendering for desktop and Android mail clients.

## 0.11.4 - 2026-06-17

### Fixed

- Prepared a new Windows build version after the unsigned local installer build fix.

## 0.11.3 - 2026-06-16

### Fixed

- Fixed local Windows installer builds without code-signing privileges by disabling electron-builder's signing/editing step while keeping the existing after-pack metadata update for the app executable.

## 0.11.2 - 2026-06-16

### Fixed

- Fixed Windows installer builds with electron-builder 26.8.1 by removing the unsupported signing option that stopped configuration validation.

## 0.11.1 - 2026-06-15

### Added

- Added the startup-at-login choice to onboarding so new users can decide during first setup.

### Fixed

- Restored Windows executable resource editing so packaged installer builds embed the PrivateTranscribe icon while still skipping code signing.

## 0.11.0 - 2026-06-14

### Added

- Support for long-running dictation sessions, including stronger recorder handling for longer speech input.
- A PrivateTranscribe design taste guide to keep future UI changes calm, private, and product-specific.

### Changed

- Improved dashboard layout, setup summary, responsive stat pills, and microphone configuration presentation.
- Simplified the tester feedback submission flow and aligned feedback categories with the backend.
- Clarified startup and dictation setup copy so first-time setup is easier to understand.

### Fixed

- Hardened dictation finalization to reduce race conditions and prevent losing the tail end of longer dictations.
- Restored the overlay microphone visualizer after system wake/resume scenarios.
- Prevented dashboard WPM values from overflowing in narrow layouts.

## 0.10.5 - 2026-06-11

### Added

- Structured tester feedback categories and quick templates for clearer launch reports.
- Opt-in transcription text diagnostics for developer testing (`debugTranscriptionText`) so raw, normalized, and final transcription output can be compared without hardcoded word repairs.

### Changed

- Clarified transcription settings copy: spoken language and output language are now easier to understand.
- High-VRAM NVIDIA CUDA systems (16GB+ VRAM) now recommend Whisper Large for better local transcription accuracy.

### Fixed

- Developer auto-start registration now passes the correct launch arguments.
- Stale hidden translation settings are ignored when translation is unsupported by the selected local model or auto-detect mode.
- First-open diagnostics are deferred so they do not interfere with startup/settings initialization.
