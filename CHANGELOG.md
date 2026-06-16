# Changelog

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
