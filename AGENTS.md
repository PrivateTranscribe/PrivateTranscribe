# AGENTS.md

Guidance for coding agents in this repository. Codex reads this file directly; `CLAUDE.md` imports it, so Claude Code reads the same text.

Follow `.github/CONTRIBUTING.md` to set up a fresh clone or prepare a pull request.

## Project

PrivateTranscribe is an Electron desktop dictation app. It transcribes locally with whisper.cpp or NVIDIA Parakeet, or in the cloud through OpenAI, Groq or a custom endpoint, and can clean text up with an AI model (OpenAI, Anthropic, Gemini, Groq, or a local GGUF model). React 19, TypeScript, Tailwind CSS v4, shadcn/ui, better-sqlite3.

- The product name is **PrivateTranscribe**. The app forked from OpenWhispr; `OpenWhispr`, `Privoca` and `DictateVoice` belong only in historical notes, migration code and upstream comparisons.
- Releases ship for Windows only. The macOS and Linux paths inherited from upstream (Globe key, GNOME shortcuts, xdotool paste) stay in the code, and no workflow builds or tests them.

## Rules

- Work on the current branch. Push, merge, release, or create and switch branches only when asked.
- Keep private and local features local: a cloud dependency enters only when the request names it.
- Commit each feature, fix or doc update on its own, with its tests or docs and no unrelated formatting churn. Subjects are imperative and specific (`Restore Whisper file temperature fallback`). Non-trivial changes get a body: why, what changed in behaviour, how it was verified.
- Read `docs/DESIGN_TASTE_GUIDE.md` before changing product-facing UI, settings, onboarding, empty states or marketing copy. The direction is a calm operator UI: visible system state, product-specific copy, motion only where it clarifies state.
- Read `docs/WHISPER_CUDA_ENGINE.md` before changing anything about the CUDA Whisper engine: its zip package, download, readiness state, or the General settings card. The fix for a GPU problem lives in that package, never in asking users to install the CUDA Toolkit.

## Verification

Before claiming success, pass the gates the change touches, and say so when one cannot run:

- `npm run format:check`, `npm test` and `npm run build:renderer`: the three CI runs on every push.
- Targeted unit tests for changed helper logic, for example `npm test -- tests/unit/helpers/parakeetClient.test.ts`.
- The e2e spec for the flow you changed, for example `npm run test:e2e -- tests/e2e/parakeet-dictation.spec.ts`.
- For a release: the update manifest and installer checks under Release.

There is no `typecheck` script.

### End-to-end tests

Playwright drives the real Electron app (`playwright.config.ts`, specs and fixture in `tests/e2e/`).

- `tests/e2e/global-setup.ts` rebuilds `src/dist` when it is older than `src/`; specs load that built bundle, so no Vite server runs. `PT_E2E_SKIP_BUILD=1` reuses the current build.
- `tests/e2e/fixtures/electron-app.ts` gives each test a throwaway `--user-data-dir`, blanks every `*_API_KEY` so a run never reaches a paid provider, pre-denies analytics, and sets `PRIVATETRANSCRIBE_DIAG_DISABLE_*` flags for the global shortcut, key listener, tray and audio ducking.
- Windows open at opacity 0, click-through and inactive, so a run never steals focus; an app-launch spec asserts this. Some specs still use the clipboard and send keys.
- A spec overrides `completeOnboarding` (default `true`) or `appEnv` with `test.use({ ... })`.

## Architecture

- **Two windows, one React codebase routed by URL parameter:** the always-on-top dictation overlay (`src/App.jsx`) and the Control Panel (`src/components/ControlPanelShell.tsx` with `AppSidebar.tsx`).
- **Processes:** `main.js` owns windows, IPC, the database and native binaries; `preload.js` exposes `window.electronAPI`; the renderer in `src/` runs with context isolation and no Node access.
- **Audio pipeline:** MediaRecorder → blob → IPC → temp file → whisper.cpp, Parakeet or a cloud API → text → paste → temp file deleted.

### Key Module Locations

| Area                                | Files                                                                                                                                                                                                                                    |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Electron entry and window lifecycle | `main.js`, `src/helpers/windowManager.js`, `src/helpers/windowConfig.js`                                                                                                                                                                 |
| IPC handlers (all channels)         | `src/helpers/ipcHandlers.js`, `preload.js`                                                                                                                                                                                               |
| Audio recording                     | `src/hooks/useAudioRecording.js`, `src/helpers/audioManager.js`                                                                                                                                                                          |
| Local Whisper (whisper.cpp)         | `src/helpers/whisper.js`, `src/helpers/whisperServer.js`                                                                                                                                                                                 |
| Whisper CUDA engine                 | `src/helpers/gpuBinaryManager.js`, `.github/workflows/build-cuda-binary.yml`                                                                                                                                                             |
| Local Parakeet (sherpa-onnx-node)   | `src/helpers/parakeet.js` (model files), `src/helpers/parakeetClient.js` + `parakeetHost.js` (utility process, no network port), `src/helpers/parakeetAudio.js` (trim, normalise, pieces of 60 s or less: one decode past 400 s crashes) |
| AI text processing                  | `src/services/ReasoningService.ts`; local models via `src/services/localReasoningBridge.js` and `src/helpers/llamaServer.js`                                                                                                             |
| Model registry                      | `src/models/modelRegistryData.json` (single source of truth for every model), `src/models/ModelRegistry.ts`                                                                                                                              |
| Local model files                   | `src/helpers/modelManagerBridge.js`, `src/helpers/modelDirUtils.js`                                                                                                                                                                      |
| Settings                            | `src/hooks/useSettings.ts`, `src/components/SettingsPage.tsx`                                                                                                                                                                            |
| Prompts                             | `src/config/prompts.ts`, `src/config/promptData.json`, `src/helpers/prompts.js`                                                                                                                                                          |
| API keys                            | `src/helpers/environment.js`                                                                                                                                                                                                             |
| Constants and endpoints             | `src/config/constants.ts`                                                                                                                                                                                                                |
| Paste                               | `src/helpers/clipboard.js`                                                                                                                                                                                                               |
| Hotkeys                             | `src/helpers/hotkeyManager.js`; Windows push-to-talk `src/helpers/windowsKeyManager.js` + `resources/windows-key-listener.c`                                                                                                             |
| Read Aloud in-place highlight       | `src/helpers/readAloudHighlight.js`, `resources/readaloud-highlight-worker.ps1`                                                                                                                                                          |
| Database                            | `src/helpers/database.js`                                                                                                                                                                                                                |
| Auto-updater                        | `src/updater.js`, `src/hooks/useUpdater.ts`                                                                                                                                                                                              |
| Logging                             | `src/helpers/debugLogger.js`, `src/utils/logger.ts`                                                                                                                                                                                      |
| Temp files, downloads, FFmpeg       | `src/helpers/safeTempDir.js`, `src/helpers/downloadUtils.js`, `src/helpers/ffmpegUtils.js`                                                                                                                                               |
| Release                             | `.github/workflows/release.yml`                                                                                                                                                                                                          |

### Control Panel Page Architecture

Each sidebar page is a component in `src/components/pages/`, routed by page id in `ControlPanelShell.tsx`.

| Page id                           | Component                                                                        |
| --------------------------------- | -------------------------------------------------------------------------------- |
| `home`                            | `DashboardPage.tsx`                                                              |
| `transcribe`                      | `TranscribePage.tsx`                                                             |
| `dictation`                       | `DictationPage.tsx`, which renders the `dictation` section of `SettingsPage.tsx` |
| `history`                         | `HistoryPage.tsx`                                                                |
| `dictionary`, `correction-memory` | `DictionaryPage.tsx`; the second embeds `CorrectionMemoryPage.tsx`               |
| `read-aloud`                      | `ReadAloudPage.tsx`                                                              |
| `ai-enhancement`                  | `AIEnhancementPage.tsx`                                                          |
| `converse`                        | `ConversePage.tsx`                                                               |
| `action-engine`                   | `ActionEnginePage.tsx`                                                           |
| `settings`                        | `SettingsPageWrapper.tsx` → `SettingsPage.tsx`                                   |

### Adding a feature

- **IPC channel:** a handler in `src/helpers/ipcHandlers.js` and its bridge in `preload.js`.
- **Setting:** `src/hooks/useSettings.ts` and `src/components/SettingsPage.tsx`.
- **Page:** a component in `src/components/pages/` and a route in `ControlPanelShell.tsx`.
- **Model:** an entry in `src/models/modelRegistryData.json`.
- **UI primitive:** follow the shadcn/ui patterns in `src/components/ui/`.
- **Main-process helper:** a module in `src/helpers/`, initialised in `main.js`.

## Where data lives

- **API keys:** `src/helpers/environment.js` encrypts them with Electron `safeStorage` into `keys.enc` in `userData`. The `.env` in `userData` holds non-secret settings only; on load the app moves any clear-text key it finds there into `keys.enc`.
- **Renderer settings:** localStorage, through `useSettings.ts`.
- **History and stats:** `transcriptions.db` (`transcriptions-dev.db` in development) in `userData`; the tables are created in `src/helpers/database.js`.
- **Models:** `~/.cache/PrivateTranscribe/whisper-models/` and `~/.cache/PrivateTranscribe/parakeet-models/`; `modelDirUtils.js` migrates the old `~/.cache/Privoca/` on first run.
- **Debug logs:** start with `--log-level=debug` or set `PT_LOG_LEVEL=debug`.

The installed app and a development copy share `%APPDATA%\PrivateTranscribe` and a single-instance lock.

## AI providers

The model lists live in `modelRegistryData.json`. Behaviour that the registry does not show:

- **OpenAI** uses the Responses API (`/v1/responses`) and caches per model whether it falls back to chat completions. GPT-5 and o-series models take no `temperature`.
- **Anthropic** calls go through the main process over IPC, which avoids CORS. Model ids use the alias form (`claude-sonnet-4-5`).
- **Gemini** is called straight from the renderer; handle its thinking output and the `MAX_TOKENS` finish reason.
- **Groq** uses the OpenAI-compatible endpoint; some models carry `disableThinking: true`.
- **Custom endpoints** take an OpenAI-compatible base URL. Normalisation strips suffixes such as `/chat/completions`, and known Groq, Anthropic and Gemini URLs are refused as an OpenAI base.

## Windows build and packaging

- `npm run dev` compiles the native helpers first and fetches the Whisper engine into `resources/bin` on its first run. `npm run pack` builds an unsigned app. `prebuild`, `prepack` and `predist` run `prepare:resources`, which compiles the native helpers, downloads whisper.cpp and llama-server, and copies the Visual C++ runtime.
- Paste goes through `windows-fast-paste.exe`; when it is missing or fails, the text stays on the clipboard.
- Push-to-talk uses `windows-key-listener.exe` (a `WH_KEYBOARD_LL` hook, compound hotkeys such as `Ctrl+Shift+F11`). Without it, the hotkey falls back to tap mode.
- After changing dependencies or bundled binaries, run `npm run notices`. A new file in `resources/bin` also needs an entry in `resources/third-party/components.json`, or the Windows build stops in afterPack.
- afterPack also stops the build when a shipped binary imports a Visual C++ runtime DLL (`msvcp140*`, `vcruntime140*`) missing from its own folder. Windows looks there, then in System32, which has them only where the redistributable is installed, so a developer PC cannot reveal the gap. `npm run copy:vc-runtime` (part of `prepare:resources`) fills `resources/bin`, and `electron-builder.json` copies the set next to onnxruntime-node, which never looks in `resources/bin`.

## Release

Releases run from `main` through `release.yml`. Its build job waits in the protected `production` environment until Kristian approves it. Release only when asked:

1. Commit the version bump in `package.json` and a `## X.Y.Z - YYYY-MM-DD` section in `CHANGELOG.md` on `main`, and push.
2. Start the workflow: `gh workflow run release.yml --ref main`. It fails early when tag `vX.Y.Z` exists or the changelog has no entry, then waits for approval.
3. Check that `https://updates.privatetranscribe.com/win/latest.yml` names the new version and the installer returns HTTP 200.

## Code style

- Prettier and ESLint configs are the source of truth; `npm run format` applies both. The root `eslint.config.js` covers the CommonJS main process, `src/eslint.config.js` the React and TypeScript renderer.
- New React components are TypeScript (`.tsx`). Main-process helpers are plain CommonJS JavaScript.
- `@` resolves to `src/` in Vite builds.
