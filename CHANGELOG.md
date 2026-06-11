# Changelog

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
