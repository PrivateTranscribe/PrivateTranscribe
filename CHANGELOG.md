# Changelog

## 0.16.0 - 2026-08-27

### Added

- Read Aloud. Select text anywhere, press the hotkey, and PrivateTranscribe reads it back to you in a voice that never leaves your machine. It has its own page, 28 voices you can listen to before you pick one, and a player in the overlay that shows the sentence it is on.
- You can steer a read while it happens, from the overlay or the keyboard. Ctrl+Alt+Space pauses and resumes, and Ctrl+Alt+left/right skip a sentence at a time.
- Converse. Hold a spoken conversation with an agent that can do real work on your machine. It has its own page and overlay, talking over it stops the speech straight away and tells the agent what it missed, and a conversation survives restarting the app.
- Other apps are turned down while Read Aloud speaks, then put back where you had them.

### Changed

- Read Aloud starts on the first clause instead of waiting for a whole sentence, and the engine warms up in advance, so the first press no longer stutters.
- Transcribing no longer overwrites your clipboard unless you ask it to.
- The Transcribe page takes its language from the languages you already said you speak.
- Voice Assistant now lives inside AI Enhancement instead of having its own page.
- Every overlay sits in one column under the dictation button rather than scattering across the screen.
- Read Aloud skips text that is not English and tells you, instead of garbling it.
- Reading aloud no longer takes the whole machine with it. Its threadpool is capped so everything else stays responsive.

### Fixed

- Start on boot works. The switch was stuck on, claiming the app would launch at login when nothing was actually registered, and every attempt to change it failed with a warning blaming security software. It now reads the real Windows startup entry, so it tells the truth and can be turned on and off.
- File transcription no longer crashes when you cancel it, and stops transcribing in the wrong language.
- A compound hotkey no longer misses the press when both keys land at the same instant.
- The Read Aloud hotkey always answers, including in the middle of a read.
- Tapping the dictation button over and over no longer walks your system volume down for good, and volumes come back even when a read never reports finishing.
- Exported settings now carry your agent name and your custom prompt.
- The firewall advice no longer points at a rule that does not cover the transcription engine.

## 0.15.0 - 2026-08-23

### Added

- You can now name every language you speak, instead of picking one. Whisper is held to that set, so a Danish sentence with English words in it stops being guessed as a different language halfway through.
- Local transcription now lets you choose how many CPU cores it uses, in Settings. It previously took four regardless of how many the machine had.
- The speed test now says how long a one-minute dictation actually takes, rather than only a multiplier.
- Prices are shown and charged in your own currency where Stripe supports it.

### Changed

- The custom dictionary is one flat list of terms. The three modes it had before did the same job three ways.
- Optional analytics now also cover transcription speed, the compute mode, and the configured language and model. Nobody is opted in by this: the disclosure changed, so everyone is asked again, and a previous "no" stays no. No audio, transcript text, filenames, window titles, or API keys are ever sent.
- CPU mode now really does keep the GPU out of it.
- Every locked beta feature says so once, on the control that is locked, and links to how to get access.
- The update notice moved from the title bar to the sidebar footer, right above the version marker, so the build you are running and the one waiting for you sit together.

### Fixed

- The spoken-language picker no longer clips its list, hides its control, or leaves you unable to remove the last language.
- Your first language is no longer forced onto every later dictation.
- History entries stop being cut mid-word long before the preview is full.
- Start on boot now refuses, and says why, when the app is running from a temporary folder that Windows will clean up. Before this it could leave a startup entry that showed an Electron error on every boot.

## 0.14.2 - 2026-08-15

### Changed

- Updates can now download only the parts that changed instead of the whole installer.

### Fixed

- A CUDA engine download that is already running is now shown as running, instead of offering to start it again.
- The app now says what happens to a CUDA download if you quit part way through it.

## 0.14.1 - 2026-08-15

### Added

- You can recover a lost license key yourself at privatetranscribe.com/license.

### Changed

- Voice call mute holds your mute key down for the whole dictation instead of pressing it over and over.
- Whisper models in the picker are sorted by size instead of internal order.
- A refunded license now loses Pro, as the refund policy always said it would.

### Fixed

- The CUDA engine download showed the wrong size.
- When Windows blocks the GPU engine the app says so, instead of blaming a driver update.

## 0.14.0 - 2026-08-13

### Added

- Windows installers and the app itself are now code signed, so Windows no longer says the publisher is unknown.
- Added voice call mute, which holds your voice app's push to mute key while you dictate so nobody on the call hears it. You can use a keyboard key or a mouse button.
- Added a language step to onboarding, so the app knows what you speak before it recommends a model.

### Changed

- The spoken language is detected once at the start of a recording and kept for the rest of it, instead of being guessed again on every segment.
- The AI now answers in the language you spoke.
- Accuracy figures in the model picker follow the language you actually dictate in.
- Raw dictation audio is no longer kept on disk after transcription.
- Transcript history limits are enforced strictly, and your streak survives turning history off.
- Correction memory asks for approval before it changes anything.
- Long dictations now split at a natural pause instead of on a timer.

### Fixed

- Long dictations no longer lose sections, and one failed chunk no longer takes the rest of the recording with it.
- Stopped the last half second of speech being cut off.
- Pasting on Windows now confirms the text actually landed before reporting success, and keeps the clipboard fallback when it cannot.
- Fixed tap and hold gestures being mistaken for each other.
- Development runs no longer add themselves to Windows startup.
- Fixed dropdown, theme and spacing inconsistencies across the app.

## 0.13.11 - 2026-08-09

### Fixed

- Ensured an active paid Pro license bypasses the Starter daily word limit in packaged production builds.
- Replaced the raw updater error in unsupported unpacked builds with a clear link to the official Windows installer.

## 0.13.10 - 2026-08-08

### Changed

- Separated stable paid Pro access from unfinished Beta features, which remain limited to approved testers.
- Simplified the active Pro license message around unlimited private dictation.

### Fixed

- Applied a newly activated Pro license immediately, including after the Starter daily word limit has already been reached.
- Prevented development previews from accidentally granting approved-tester access or masking a real paid license after activation.
- Preserved complete audio across long dictations and reduced truncated or hallucinated transcript endings.
- Restored reliable navigation between the dictation overlay and control panel.
- Kept transparent overlay regions click-through and removed repeated toast notifications.

## 0.13.9 - 2026-08-07

### Added

- Added OpenAI GPT Transcribe as a recommended cloud transcription model.

### Changed

- Hardened app navigation, model downloads, release credentials, and local API key storage.

### Fixed

- Fixed automatic pasting into Windows terminals such as Claude Code, which now use the terminal paste shortcut and get time to finish before the clipboard is restored.
- Fixed pasting when a dictation hotkey modifier is still held down, which previously turned the paste into a different shortcut and did nothing.
- Stopped antivirus warnings during auto-paste by dropping PowerShell from the Windows paste path entirely.
- Fixed the Transcribe language menu clipping near the bottom of the window.
- Fixed the misspelled PrivateTranscribe entry in the Windows Start Menu.

## 0.13.7 - 2026-07-27

### Added

- Added a tray toggle that suspends the dictation hotkey for the current session.
- Added a Settings control for changing product analytics consent at any time.

### Changed

- Constrained the pseudonymous analytics events to known values, removed duplicate emitters, and added a 12-month retention policy.

### Fixed

- Disabling PrivateTranscribe's startup entry in Windows Task Manager or Windows Settings is now respected: the app no longer re-enables it behind the user's back, and the startup setting in the app reflects the real Windows state.

## 0.13.6 - 2026-07-13

### Changed

- Replaced the Starter usage card's midnight reset label with a live countdown showing the hours and minutes until the daily allowance resets.

## 0.13.5 - 2026-07-13

### Added

- Added a Dashboard card showing Starter words used, words remaining, and when the daily allowance resets.

### Changed

- Pre-warmed the local transcription server when recording starts so it can load while the user is speaking.
- Improved overlay visibility handling so taskbar snapping, tray actions, and settings use one reliable hide/show state.
- Added a verified recovery workflow for publishing CUDA engine version metadata without rebuilding existing packages.

### Fixed

- Allowed slow local model cold starts up to 60 seconds without leaving failed startup attempts hanging indefinitely.

## 0.13.4 - 2026-07-10

### Changed

- Made CUDA engine installation, model cache migration, hardware detection, Parakeet model deletion, and audio file I/O non-blocking so startup and transcription flows stay responsive.

## 0.13.3 - 2026-07-09

### Fixed

- Renamed the production Settings `Developer` tab to `Data & Storage`.
- Removed the empty production-only `Diagnostics & Data` header when developer diagnostics are hidden.

## 0.13.2 - 2026-07-08

### Fixed

- Fixed packaged builds accidentally treating themselves like development builds, which unlocked Pro features without a valid license.
- Restored Pro surfaces in Settings to the website's purple Pro accent instead of green/mint status styling.

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
