# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Follow `CONTRIBUTING.md` to set up a fresh clone or prepare a pull request.

## Project Overview

PrivateTranscribe is an Electron desktop dictation app. It originated from OpenWhispr, but the product rename is complete and new work must treat PrivateTranscribe as the canonical product. It uses whisper.cpp and NVIDIA Parakeet (via sherpa-onnx) for local speech-to-text, plus OpenAI, Groq, and custom cloud APIs for cloud transcription. AI reasoning is multi-provider (OpenAI, Anthropic, Gemini, Groq, local GGUF). React 19 + TypeScript + Tailwind CSS v4 frontend, better-sqlite3 for history, shadcn/ui components.

**Naming note**: Use **PrivateTranscribe** as the product name. Legacy `OpenWhispr`, `Privoca`, and `DictateVoice` references may remain only in historical notes, migration/backward-compatibility paths, or upstream comparison docs. New product-facing changes must use `PrivateTranscribe`.

## Common Commands

### Development
```bash
npm install          # Install dependencies (runs postinstall for electron-builder)
npm run dev          # Start dev mode (Vite dev server on port 5174 + Electron, compiles native helpers first)
npm run dev:renderer # Vite dev server only (no Electron)
```

### Building
```bash
npm run pack         # Build WITHOUT code signing (personal use, recommended for dev)
npm run build        # Build WITH signing (requires certificates)
npm run build:win    # Windows-only build with signing
npm run build:mac    # macOS-only build with signing
npm run build:linux  # Linux-only build
npm run dist         # Full distribution build
```

### Code Quality
```bash
npm run format       # ESLint fix + Prettier write (all files)
npm run format:check # ESLint check + Prettier check (CI-safe, no modifications)
```

### Testing
```bash
npm run test           # Run all Vitest tests
npm run test:watch     # Run tests in watch mode
npm run test:coverage  # Run tests with coverage report
npm run test:legacy    # Run legacy setup-validation tests
```

Test files are located in `tests/unit/` organized by module:
- `tests/unit/utils/` - Utility function tests (SecureCache, retry, urlUtils, formatBytes, hotkeys, languages)
- `tests/unit/config/` - Configuration helper tests (normalizeBaseUrl, buildApiUrl)
- `tests/unit/helpers/` - Helper module tests (database, whisperParser, contextSanitizer)
- `tests/unit/models/` - Model registry tests

Coverage targets: 60% statements, 50% branches/functions.

#### End-to-end tests (Playwright + Electron)

```bash
npm run test:e2e         # Launch the real app and run tests/e2e/*.spec.ts
npm run test:e2e:ui      # Playwright UI mode
npm run test:e2e:debug   # Step through with the inspector
npm run test:e2e:report  # Open the last HTML report
```

Config lives in `playwright.config.ts`; specs and the shared fixture live in `tests/e2e/`.
No browser download is needed — Playwright drives the Electron binary from `node_modules`.

How the suite behaves:
- `tests/e2e/global-setup.ts` builds `src/dist` when it is missing or older than
  `src/` sources. Specs run in production mode, so the app loads the built bundle
  via `loadFile()` and no Vite dev server is required. `PT_E2E_SKIP_BUILD=1` reuses
  whatever is already built.
- The `tests/e2e/fixtures/electron-app.ts` fixture gives each test a throwaway
  `--user-data-dir`, blanks all `*_API_KEY` variables so a run can never reach a
  paid provider, pre-denies analytics, and sets the existing
  `PRIVATETRANSCRIBE_DIAG_DISABLE_*` flags for the global shortcut, Windows key
  listener, and tray.
- Windows are forced to opacity 0, click-through, not-always-on-top, and shown
  with `showInactive()`, so a run never steals focus or covers the screen. An
  app-launch spec asserts this, so it cannot regress silently.
- Traces, screenshots, console output, and the user-data dir are kept only for
  failing tests.

Fixture options a spec can override with `test.use({ ... })`: `completeOnboarding`
(default `true`) and `appEnv` (extra environment variables for the launched app).

### Binary Downloads (needed before packaging)
```bash
npm run download:whisper-cpp      # Current platform
npm run download:whisper-cpp:all  # All platforms
npm run download:llama-server     # Current platform
npm run download:sherpa-onnx      # Current platform
```
Note: `prebuild`/`prepack`/`predist` scripts automatically run these downloads before `npm run build`/`pack`/`dist`.

## Architecture

### Dual Window System
- **Main Window**: Minimal always-on-top overlay for dictation (`src/App.jsx`)
- **Control Panel**: Full settings/history/dashboard window (`src/components/ControlPanelShell.tsx` and page components)
- Both share the same React codebase, routed by URL parameter

### Process Model (Electron)
- **Main process** (`main.js`): Window management, IPC handlers, database, native binary spawning
- **Preload** (`preload.js`): Secure IPC bridge exposing `window.api` to renderer
- **Renderer** (`src/`): React app with context isolation — no direct Node.js access

### Audio Pipeline
MediaRecorder API → Blob → ArrayBuffer → IPC → temp file → whisper.cpp/sherpa-onnx → result → clipboard paste → temp file deleted

### Key Module Locations

| Area | Files |
|------|-------|
| Electron entry + window lifecycle | `main.js`, `src/helpers/windowManager.js`, `src/helpers/windowConfig.js` |
| IPC handlers (all channels) | `src/helpers/ipcHandlers.js`, `preload.js` |
| Audio recording | `src/hooks/useAudioRecording.js`, `src/helpers/audioManager.js` |
| Transcription (local whisper.cpp) | `src/helpers/whisper.js`, `src/helpers/whisperServer.js` |
| Transcription (local Parakeet/sherpa-onnx) | `src/helpers/parakeet.js`, `src/helpers/parakeetServer.js`, `src/helpers/parakeetWsServer.js` |
| AI reasoning (multi-provider) | `src/services/ReasoningService.ts` |
| Local AI reasoning (llama.cpp) | `src/services/localReasoningBridge.js` |
| llama.cpp server management | `src/helpers/llamaServer.js` |
| Model registry (single source of truth) | `src/models/modelRegistryData.json`, `src/models/ModelRegistry.ts` |
| Local model management | `src/helpers/modelManagerBridge.js`, `src/helpers/modelDirUtils.js` |
| Settings management | `src/hooks/useSettings.ts`, `src/components/SettingsPage.tsx` |
| Prompt system | `src/config/prompts.ts`, `src/config/promptData.json`, `src/helpers/prompts.js` |
| API constants & endpoints | `src/config/constants.ts` |
| Clipboard/paste (platform-specific) | `src/helpers/clipboard.js` |
| Hotkey system | `src/helpers/hotkeyManager.js`, `src/helpers/gnomeShortcut.js` (GNOME Wayland D-Bus) |
| macOS Globe key | `src/helpers/globeKeyManager.js`, `resources/macos-globe-listener.swift` |
| Windows Push-to-Talk | `src/helpers/windowsKeyManager.js`, `resources/windows-key-listener.c` |
| Read Aloud in-place highlight (UI Automation) | `src/helpers/readAloudHighlight.js`, `resources/readaloud-highlight-worker.ps1` |
| Database | `src/helpers/database.js` |
| Auto-updater | `src/updater.js`, `src/hooks/useUpdater.ts` |
| Debug logging | `src/helpers/debugLogger.js`, `src/utils/logger.ts` |
| FFmpeg utilities | `src/helpers/ffmpegUtils.js` |
| Safe temp directories | `src/helpers/safeTempDir.js` |
| Download utilities | `src/helpers/downloadUtils.js` |
| Build/download scripts | `scripts/` directory |

### Control Panel Page Architecture

The Control Panel uses a sidebar-based layout (`AppSidebar.tsx` + `ControlPanelShell.tsx`) with dedicated page components in `src/components/pages/`:

| Page | File |
|------|------|
| Dashboard | `DashboardPage.tsx` |
| Transcribe | `TranscribePage.tsx` |
| History | `HistoryPage.tsx` |
| AI Enhancement | `AIEnhancementPage.tsx` |
| Read Aloud | `ReadAloudPage.tsx` |
| Converse | `ConversePage.tsx` |
| Dictionary | `DictionaryPage.tsx` |
| Correction Memory (embedded in Dictionary) | `CorrectionMemoryPage.tsx` renders inside `DictionaryPage.tsx` (`ControlPanelShell` routes the `correction-memory` page id to `DictionaryPage`) |
| Action Engine | `ActionEnginePage.tsx` |
| Settings | `SettingsPageWrapper.tsx` → `SettingsPage.tsx` |

### Platform-Specific Behavior
- **macOS**: Globe/Fn key via Swift binary (`resources/macos-globe-listener.swift`, managed by `globeKeyManager.js`), AppleScript clipboard paste, accessibility permissions required
- **Windows**: Native `windows-key-listener.exe` for push-to-talk low-level keyboard hooks, native `windows-fast-paste.exe` for paste
- **Linux**: GNOME Wayland uses D-Bus shortcuts (`gnomeShortcut.js`); clipboard uses xdotool/wtype/ydotool depending on display server
- Native binaries compiled automatically via `predev`/`prebuild` scripts (`npm run compile:native`)

### Adding New Features
- **New IPC channel**: Add handler in `src/helpers/ipcHandlers.js` AND expose in `preload.js`
- **New setting**: Update `src/hooks/useSettings.ts` and `src/components/SettingsPage.tsx`
- **New UI component**: Follow shadcn/ui patterns in `src/components/ui/`
- **New page**: Create in `src/components/pages/`, add route in `ControlPanelShell.tsx`
- **New AI model**: Add to `src/models/modelRegistryData.json` (single source of truth)
- **New manager/helper**: Create in `src/helpers/`, initialize in `main.js`

## Product UI / Design Taste

Before changing product-facing UI, settings screens, onboarding, empty states, or marketing copy, read:

- `docs/DESIGN_TASTE_GUIDE.md`

Default design direction: calm operator UI, visible system state, product-specific copy, and sparse motion only when it clarifies state. Avoid generic AI SaaS polish, vague buzzwords, and decorative animation.

## Code Style

- **Formatting**: Prettier with double quotes, semicolons, 2-space indent, 100 char width, trailing commas (es5), LF line endings (`.prettierrc`)
- **Linting**: ESLint flat config — root `eslint.config.js` for main process (CommonJS), `src/eslint.config.js` for React/TypeScript
- **New React components**: Use TypeScript (`.tsx`)
- **Main process helpers**: Plain JavaScript (`.js`, CommonJS)
- Path alias `@` resolves to `src/` in Vite builds

## Commit Discipline

- Commit each feature, bug fix, or documentation update separately.
- Combine files in one commit only when they are part of the same behavior change.
- Keep each commit reviewable on its own: include related tests or docs and avoid unrelated formatting churn.
- Use concise, imperative, specific commit subjects.
- Add a commit body for non-trivial changes with why it changed and how it was verified.
- Push, merge, or create and switch branches only when asked.

## Build System

- **Vite** for renderer bundling (`src/vite.config.mjs`): port 5174, React plugin, Tailwind CSS v4 plugin, relative base path for `file://` protocol
- **electron-builder** for packaging (`electron-builder.json`): App ID `com.PrivateTranscribe.app`, product name `PrivateTranscribe` 
- ASAR unpacking required for `ffmpeg-static` and `better-sqlite3`
- Extra resources: binaries in `resources/bin/` (whisper-cpp, whisper-server, llama-server, sherpa-onnx, key listeners)
- Whisper models stored at `~/.cache/PrivateTranscribe/whisper-models/`, Parakeet models at `~/.cache/PrivateTranscribe/parakeet-models/` (migration from old ~/.cache/Privoca/ handled automatically on first run via modelDirUtils.js)
- Linux targets: AppImage, deb, rpm, tar.gz, flatpak
- Windows targets: NSIS installer, portable
- macOS targets: DMG and zip (both x64 and arm64)

## Environment Variables

Copy `.env.example` to `.env`. Key variables:
- `OPENAI_API_KEY` — OpenAI API key (transcription + reasoning)
- `ANTHROPIC_API_KEY` — Anthropic API key (reasoning)
- `GEMINI_API_KEY` — Google Gemini API key (reasoning)
- `GROQ_API_KEY` — Groq API key (ultra-fast cloud transcription + reasoning)
- `WHISPER_MODEL` — Cloud whisper model override (default: `whisper-1`)
- `LANGUAGE` — Language code for transcription (empty = auto-detect)
- `PT_LOG_LEVEL=debug` — Enable debug logging 

## Database Schema

SQLite via better-sqlite3. Database file: `transcriptions.db` (or `transcriptions-dev.db` in development) in Electron's `userData` directory.

### Tables

```sql
-- Transcription history
CREATE TABLE transcriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  text TEXT NOT NULL,
  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Custom dictionary for transcription accuracy
CREATE TABLE custom_dictionary (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  word TEXT NOT NULL UNIQUE,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Aggregate statistics (single row, persists when transcriptions are cleared)
CREATE TABLE stats (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  total_words INTEGER DEFAULT 0,
  total_transcriptions INTEGER DEFAULT 0,
  total_seconds REAL DEFAULT 0,
  average_wpm REAL DEFAULT 0,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

## AI Provider Architecture

All model definitions centralized in `src/models/modelRegistryData.json` as single source of truth.

### Cloud Transcription Providers

| Provider | Models | Notes |
|----------|--------|-------|
| **OpenAI** | GPT-4o Transcribe, GPT-4o Mini Transcribe, Whisper-1 | Default provider |
| **Groq** | Whisper Large v3 Turbo (216x real-time) | Ultra-fast |

### Cloud Reasoning Providers

| Provider | Models | Integration |
|----------|--------|-------------|
| **OpenAI** | GPT-5.2, GPT-5 Mini, GPT-5 Nano, GPT-4.1, GPT-4.1 Mini, GPT-4.1 Nano | Responses API (`/v1/responses`) |
| **Anthropic** | Claude Sonnet 4.5, Claude Haiku 4.5, Claude Opus 4.5 | Via IPC bridge (avoids CORS) |
| **Google Gemini** | Gemini 3 Pro (preview), Gemini 3 Flash (preview), Gemini 2.5 Flash Lite | Direct API calls |
| **Groq** | Qwen3 32B, GPT-OSS 120B, GPT-OSS 20B, LLaMA 3.3 70B, LLaMA 3.1 8B, Mixtral 8x7B, Gemma 2 9B | OpenAI-compatible endpoint |

### Local Transcription Providers

| Engine | Binary Pattern | Model Storage |
|--------|---------------|---------------|
| **whisper.cpp** | `resources/bin/whisper-cpp-{platform}-{arch}` | `~/.cache/PrivateTranscribe/whisper-models/` |
| **NVIDIA Parakeet** (sherpa-onnx) | `resources/bin/sherpa-onnx-{platform}-{arch}` | `~/.cache/PrivateTranscribe/parakeet-models/` |

Whisper models (GGML): tiny (75MB), base (142MB, recommended), small (466MB), medium (1.5GB), large (3GB), turbo (1.6GB)
Parakeet models: `parakeet-tdt-0.6b-v3` — multilingual 25 languages, ~680MB, INT8 quantized

### Whisper CUDA Engine Notes

See `docs/WHISPER_CUDA_ENGINE.md` before changing CUDA/GPU Whisper behavior.

Key rules from the `0.8.2` → `0.8.4` stabilization:
- The CUDA Whisper engine is a separately downloaded zip package, not just a single exe.
- Windows/Linux CUDA packages must include companion runtime libraries beside `whisper-server` (`cudart`, `cublas`, `whisper`, `ggml`, `ggml-cuda`, etc.). Do not require users to install the CUDA Toolkit.
- Modern `whisper.cpp` builds can use a small launcher plus large runtime DLLs/libs; validate total installed package/runtime libs, not only exe size.
- Spawn CUDA `whisper-server` from its binary directory and prepend that directory to `PATH` / `LD_LIBRARY_PATH`.
- `getCudaBinaryStatus().installed` means a CUDA engine exists, even if outdated; update readiness is `installed && upToDate`.
- CUDA update/download controls must stay visible in General settings, not hidden only in model/transcription settings.
- Real hardware validation: CUDA confirmed working on an RTX 5070 laptop after the `0.8.4` update UX/status fix.

### Local Reasoning (GGUF via llama.cpp)

| Family | Models |
|--------|--------|
| **Qwen** | Qwen3 32B/8B/4B/1.7B/0.6B, Qwen2.5 7B/3B/1.5B/0.5B |
| **Mistral** | Mistral 7B Instruct v0.3 (Q4, Q5) |
| **Meta Llama** | Llama 3.2 3B/1B, Llama 3.1 8B |
| **OpenAI OSS** | GPT-OSS 20B (MXFP4) |

Each local model has `hfRepo` for HuggingFace download, `promptTemplate` for chat format (ChatML, Llama, Mistral), and `contextLength`.

## Settings Storage

Settings stored in localStorage with these keys:
- `useLocalWhisper`: Boolean for local vs cloud transcription
- `whisperModel`: Selected whisper.cpp model
- `localTranscriptionProvider`: `"whisper"` or `"nvidia"`
- `parakeetModel`: Selected Parakeet model
- `cloudTranscriptionProvider`: Cloud transcription provider ID
- `cloudTranscriptionModel`: Cloud transcription model ID
- `allowOpenAIFallback`: Boolean for cloud fallback when local fails
- `allowLocalFallback`: Boolean for local fallback
- `openaiApiKey`, `anthropicApiKey`, `geminiApiKey`, `groqApiKey`: API keys
- `customTranscriptionApiKey`, `customReasoningApiKey`: Custom endpoint keys
- `preferredLanguage`: Language code for transcription
- `useReasoningModel`: Boolean to enable AI processing
- `reasoningModel`: Selected AI model for processing
- `reasoningProvider`: AI provider (`openai`/`anthropic`/`gemini`/`groq`/`local`/`custom`)
- `cloudReasoningBaseUrl`: Custom OpenAI-compatible endpoint URL
- `agentName`: User's custom agent name
- `dictationKey`: Custom hotkey configuration
- `activationMode`: `"tap"` or `"push"` (push-to-talk)
- `hasCompletedOnboarding`: Onboarding completion flag
- `customDictionary`: JSON array of words/phrases for transcription accuracy
- `theme`: `"light"`, `"dark"`, or `"auto"`
- `preferBuiltInMic`: Boolean for mic preference
- `selectedMicDeviceId`: Selected microphone device ID
- `customUnifiedPrompt`: User-customized system prompt (via PromptStudio)

## React Components

### Top-Level Components
| Component | Purpose |
|-----------|---------|
| `App.jsx` | Main dictation overlay (recording states, hotkey, audio) |
| `ControlPanelShell.tsx` | Sidebar layout shell and control panel entry point |
| `AppSidebar.tsx` | Navigation sidebar |
| `TitleBar.tsx` | Custom window title bar |
| `WindowControls.tsx` | Window minimize/maximize/close buttons |
| `OnboardingFlow.tsx` | 4-step first-time setup wizard |
| `SettingsPage.tsx` | Comprehensive settings interface |
| `TranscriptionModelPicker.tsx` | Local transcription model selection and download |
| `LocalWhisperPicker.tsx` | Whisper model picker |
| `LocalModelPicker.tsx` | Local GGUF reasoning model picker |
| `ReasoningModelSelector.tsx` | Cloud/local AI model selection |
| `DeveloperSection.tsx` | Developer settings section |

### UI Components (`src/components/ui/`)
Reusable primitives following shadcn/ui patterns: `button`, `card`, `input`, `label`, `select`, `tabs`, `dialog`, `textarea`, `tooltip`, `badge`, `toggle`, `alert`, `progress`, `dropdown-menu`.

Application-specific UI: `ActivationModeSelector`, `ApiKeyInput`, `HotkeyInput`, `LanguageSelector`, `LoadingDots`, `MarkdownRenderer`, `MicPermissionWarning`, `MicrophoneSettings`, `ModelCardList`, `DownloadProgressBar`, `PasteToolsInfo`, `PermissionCard`, `ProcessingModeSelector`, `PromptStudio`, `ProviderIcon`, `ProviderTabs`, `SettingsSection`, `SidebarModal`, `StepProgress`, `SupportDropdown`, `Toast`, `TranscriptionItem`, `InfoBox`.

### React Hooks
| Hook | Purpose |
|------|---------|
| `useAudioRecording.js` | MediaRecorder API wrapper with error handling |
| `useClipboard.ts` | Clipboard operations |
| `useDebouncedCallback.ts` | Debouncing utility |
| `useDialogs.ts` | Electron dialog integration |
| `useHotkey.js` | Hotkey state management |
| `useHotkeyRegistration.ts` | Enhanced hotkey registration with validation |
| `useLocalStorage.ts` | Type-safe localStorage wrapper |
| `useModelDownload.ts` | Model download progress tracking |
| `usePermissions.ts` | System permission checks and OS settings access |
| `useSettings.ts` | Application settings management |
| `useTheme.ts` | Theme (light/dark/auto) management |
| `useUpdater.ts` | Auto-update integration |
| `useWindowDrag.js` | Window dragging functionality |

## Utility Modules (`src/utils/`)

| File | Purpose |
|------|---------|
| `agentName.ts` | Agent name persistence |
| `audioDeviceUtils.ts` | Audio device enumeration helpers |
| `externalLinks.ts` | External link utilities |
| `formatBytes.ts` | File size formatting |
| `hotkeys.ts` | Hotkey formatting and defaults |
| `languages.ts` | Language list (58 languages + auto-detect) |
| `llamaOutputParser.js` | llama.cpp output parsing |
| `logger.ts` | Structured logging utility |
| `modelPickerStyles.ts` | Model picker styling |
| `process.js` | Process utilities |
| `providerIcons.ts` | AI provider icon mappings |
| `retry.ts` | API retry with exponential backoff |
| `SecureCache.ts` | TTL-based secure cache for API keys |
| `serverUtils.js` | Server utility functions |
| `urlUtils.ts` | URL validation and security checks |

## Build Scripts (`scripts/`)

| Script | Purpose |
|--------|---------|
| `download-whisper-cpp.js` | Downloads whisper.cpp binaries from GitHub releases |
| `download-llama-server.js` | Downloads llama.cpp server for local LLM inference |
| `download-windows-key-listener.js` | Downloads prebuilt Windows key listener binary |
| `download-sherpa-onnx.js` | Downloads sherpa-onnx binaries for Parakeet support |
| `build-globe-listener.js` | Compiles macOS Globe key listener from Swift source |
| `build-windows-key-listener.js` | Compiles Windows key listener (for local development) |
| `run-electron.js` | Development script to launch Electron with proper environment |
| `generate-icons.js` | Generates app icons in various formats |
| `generate-third-party-notices.js` | Writes THIRD_PARTY_NOTICES.md from resources/third-party/components.json and package-lock.json |
| `complete-uninstall.sh` | Full uninstall cleanup script |
| `clean-dist.bat` | Clean Windows dist folder |
| `clear-windows-icon-cache.bat` | Clear Windows icon cache |
| `lib/download-utils.js` | Shared download utilities (`fetchLatestRelease`, `downloadFile`, `extractZip`, `parseArgs`) |
| `lib/create-ico.js` | ICO file generation |

After changing dependencies or bundled binaries, run `npm run notices`. A new file in `resources/bin` also needs an entry in `resources/third-party/components.json`, or the Windows build stops in afterPack.

afterPack also stops the build when a shipped binary imports a Visual C++ runtime DLL (`msvcp140*`, `vcruntime140*`) missing from its own folder. Windows looks there, then in System32, which has them only where the redistributable is installed, so running the app on a developer PC cannot reveal the gap. `npm run copy:vc-runtime` (part of `prepare:resources`) fills `resources/bin`, and `electron-builder.json` copies the set next to onnxruntime-node, which never looks in `resources/bin`.

## API Integration Details

### OpenAI Responses API
- Endpoint: `https://api.openai.com/v1/responses`
- Simplified request format with `input` array instead of `messages`
- New response format with `output` array containing typed items
- Automatic endpoint preference caching (responses vs chat) per model
- No temperature parameter for newer models (GPT-5, o-series)

### Anthropic Integration
- Routes through IPC handler to avoid CORS issues in renderer process
- Uses main process for API calls with proper error handling
- Model IDs use alias format (e.g., `claude-sonnet-4-5` not date-suffixed versions)
- API version: `2023-06-01`

### Google Gemini Integration
- Direct API calls from renderer process
- Endpoint: `https://generativelanguage.googleapis.com/v1beta`
- Proper handling of thinking process in responses
- Error handling for MAX_TOKENS finish reason

### Groq Integration
- OpenAI-compatible endpoint: `https://api.groq.com/openai/v1`
- Used for both transcription (Whisper Large v3 Turbo) and reasoning
- Some models have `disableThinking: true` flag

### Custom Endpoints
- OpenAI-compatible custom base URLs supported
- URL normalization strips common suffixes (`/chat/completions`, `/responses`, etc.)
- Known non-OpenAI URLs (Groq, Anthropic, Gemini) auto-rejected from OpenAI base override

### API Key Persistence
- All API keys persist to `.env` file via `saveAllKeysToEnvFile()`
- Keys stored in environment variables and reloaded on app start
- Secure caching with TTL (1 hour) via `SecureCache`

## Prompt System

- `src/config/promptData.json`: Stores `UNIFIED_SYSTEM_PROMPT`, `LEGACY_PROMPTS`, `DICTIONARY_SUFFIX`
- `src/config/prompts.ts`: Exports prompt builders (`buildPrompt`, `getSystemPrompt`, `getUserPrompt`)
- Agent name injected via `{{agentName}}` template variable
- Custom dictionary appended as suffix
- User-customizable via PromptStudio UI (stored in localStorage as `customUnifiedPrompt`)
- `src/helpers/prompts.js`: Main process prompt utilities

## Custom Dictionary

- User adds words/phrases through Settings (stored in `custom_dictionary` table)
- On transcription, words joined and passed as `prompt` parameter to Whisper
- Works with both local whisper.cpp and cloud APIs
- Useful for: uncommon names, technical jargon, brand names, domain-specific terms

## Onboarding Flow

4-step first-time setup wizard (`OnboardingFlow.tsx`):
- Step 0: Permissions (microphone, accessibility, paste tools)
- Step 1: Transcription model selection
- Step 2: Hotkey configuration and activation mode
- Step 3: Completion

Progress persisted in localStorage (`onboardingCurrentStep`), clamped to valid range on version upgrades.

## Theme System

- Three modes: `light`, `dark`, `auto` (follows system preference)
- Managed via `useTheme.ts` hook
- Stored in localStorage (`theme` key)

## Platform-Specific Notes

### macOS
- Requires accessibility permissions for clipboard (auto-paste)
- Requires microphone permission (prompted by system)
- Uses AppleScript for reliable pasting
- Globe/Fn key detection via Swift binary (`macos-globe-listener`)
- Notarization needed for distribution; hardened runtime enabled
- Shows in dock with indicator dot when running (LSUIElement: false)
- whisper.cpp bundled for both arm64 and x64
- System settings accessible via `x-apple.systempreferences:` URL scheme

### Windows
- No special accessibility permissions needed
- Microphone privacy settings at `ms-settings:privacy-microphone`
- Sound settings at `ms-settings:sound`
- NSIS installer + portable build
- whisper.cpp bundled for x64
- `windows-fast-paste.exe` bundled for paste; when it is missing or fails, the text stays on the clipboard
- **Push-to-Talk**: Native `windows-key-listener.exe` with `WH_KEYBOARD_LL` low-level keyboard hook
  - Supports compound hotkeys (e.g., `Ctrl+Shift+F11`)
  - Prebuilt binary auto-downloaded from GitHub releases
  - Falls back to tap mode if unavailable

### Linux
- Targets: AppImage, deb, rpm, tar.gz, flatpak
- Standard XDG directories
- No standardized URL scheme for system settings (user must open manually)
- Privacy settings button hidden in UI
- Recommend `pavucontrol` for audio device management
- **Clipboard paste** (at least one required for auto-paste):
  - X11: `xdotool` (recommended)
  - Wayland (non-GNOME): `wtype` or `xdotool` (via XWayland)
  - GNOME Wayland: `xdotool` for XWayland apps only
  - Terminal detection: Auto-uses Ctrl+Shift+V
- **GNOME Wayland global hotkeys**:
  - Uses native GNOME shortcuts via D-Bus (`com.PrivateTranscribe.App`) and gsettings
  - Hotkeys visible in GNOME Settings → Keyboard → Shortcuts → Custom
  - Default hotkey: `Alt+R` (backtick not supported)
  - Push-to-talk unavailable (GNOME shortcuts only fire single toggle event)
  - `dbus-next` npm package for D-Bus communication

## Debug Mode

Enable with `--log-level=debug` or `PT_LOG_LEVEL=debug` (can be set in `.env`):
- Logs saved to platform-specific app data directory
- Comprehensive logging of audio pipeline, FFmpeg path resolution, audio levels
- Complete reasoning pipeline debugging with stage-by-stage logging
- Structured logger available via `src/utils/logger.ts`

## Performance & Configuration Constants

Defined in `src/config/constants.ts`:
- Token limits: 100-2048 (OpenAI), 100-4096 (Anthropic), 100-8192 (Gemini)
- API key cache TTL: 1 hour
- Retry: 3 attempts, 1-10s exponential backoff
- Model validation timeout: 5s
- Inference timeout: 30s default
- Paste delay: 50ms
- Audio blob size limits for IPC: 10MB

## Security Considerations

- API keys stored in environment variables and `.env` file
- Secure caching with auto-cleanup (`SecureCache.ts`)
- Context isolation enabled in Electron
- No remote code execution
- Sanitized file paths
- Limited IPC surface area
- URL security validation (`isSecureEndpoint` in `urlUtils.ts`)
- Custom endpoint URLs validated against known providers
