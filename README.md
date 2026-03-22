# PrivateTranscribe

An open source desktop dictation application that converts speech to text using OpenAI Whisper. Features both local and cloud processing options for maximum flexibility and privacy.

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=PrivateTranscribe/PrivateTranscribe&type=date&legend=top-left)](https://www.star-history.com/#PrivateTranscribe/PrivateTranscribe&type=date&legend=top-left)

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details. This means you can freely use, modify, and distribute this software for personal or commercial purposes.

## Features

- 🎤 **Global Hotkey**: Customizable hotkey to start/stop dictation from anywhere (default: backtick `)
- 🤖 **Multi-Provider AI Processing**: Choose between OpenAI, Anthropic Claude, Google Gemini, or local models
- 🎯 **Agent Naming**: Personalize your AI assistant with a custom name for natural interactions
- 🧠 **Multi-Provider AI**:
  - **OpenAI**: GPT-5, GPT-4.1, o-series reasoning models
  - **Anthropic**: Claude Opus 4.5, Claude Sonnet 4.5
  - **Google**: Gemini 2.5 Pro/Flash/Flash-Lite
  - **Groq**: Ultra-fast inference with Llama and Mixtral models
  - **Local**: Qwen, LLaMA, Mistral models via llama.cpp
- 🔒 **Privacy-First**: Local processing keeps your voice data completely private
- 🎨 **Modern UI**: Built with React 19, TypeScript, and Tailwind CSS v4
- 🚀 **Fast**: Optimized with Vite and modern tooling
- 📱 **Control Panel**: Manage settings, view history, and configure API keys
- 🗄️ **Transcription History**: SQLite database stores all your transcriptions locally
- 🔧 **Model Management**: Download and manage local Whisper models (tiny, base, small, medium, large, turbo)
- ⚡ **NVIDIA Parakeet**: Fast local transcription via sherpa-onnx (multilingual, 25 languages)
- 🧹 **Model Cleanup**: One-click removal of cached Whisper models with uninstall hooks to keep disks tidy
- 🌐 **Cross-Platform**: Works on macOS, Windows, and Linux
- ⚡ **Automatic Pasting**: Transcribed text automatically pastes at your cursor location
- 🖱️ **Draggable Interface**: Move the dictation panel anywhere on your screen
- 🔄 **OpenAI Responses API**: Using the latest Responses API for improved performance
- 🌐 **Globe Key Toggle (macOS)**: Optional Fn/Globe key listener for a hardware-level dictation trigger
- ⌨️ **Compound Hotkeys**: Support for multi-key combinations like `Cmd+Shift+K`
- 🎙️ **Push-to-Talk (Windows)**: Native low-level keyboard hook for true push-to-talk with compound hotkey support
- 📖 **Custom Dictionary**: Add words, names, and technical terms to improve transcription accuracy
- 🐧 **GNOME Wayland Support**: Native global shortcuts via D-Bus for GNOME Wayland users

## Prerequisites

- **Node.js 18+** and npm (Download from [nodejs.org](https://nodejs.org/))
- **macOS 10.15+**, **Windows 10+**, or **Linux**
- On macOS, Globe key support requires the Xcode Command Line Tools (`xcode-select --install`) so the bundled Swift helper can run

## Quick Start

### For Personal Use (Recommended)

1. **Clone the repository**:
   ```bash
   git clone https://github.com/PrivateTranscribe/PrivateTranscribe.git
   cd PrivateTranscribe
   ```

2. **Install dependencies**:
   ```bash
   npm install
   ```

3. **Optional: Set up API keys** (only needed for cloud processing):
   
   **Method A - Environment file**:
   ```bash
   cp env.example .env
   # Edit .env and add your API keys:
   # OPENAI_API_KEY=your_openai_key
   # ANTHROPIC_API_KEY=your_anthropic_key
   # GEMINI_API_KEY=your_gemini_key
   # GROQ_API_KEY=your_groq_key
   ```
   
   **Method B - In-app configuration**:
   - Run the app and configure API keys through the Control Panel
   - Keys are automatically saved and persist across app restarts

4. **Run the application**:
   ```bash
   npm run dev  # Development mode with hot reload
   # OR
   npm start    # Production mode
   ```

5. **Optional: Local Whisper from source** (only needed if you want local processing):
   ```bash
   npm run download:whisper-cpp
   ```
   This downloads the whisper.cpp binary for your current platform into `resources/bin/`.

### Building for Personal Use (Optional)

If you want to build a standalone app for personal use:

```bash
# Build without code signing (no certificates required)
npm run pack

# The unsigned app will be in: dist/mac-arm64/PrivateTranscribe.app (macOS)
# or dist/win-unpacked/PrivateTranscribe.exe (Windows)
# or dist/linux-unpacked/open-whispr (Linux)
```

**Note**: On macOS, you may see a security warning when first opening the unsigned app. Right-click and select "Open" to bypass this.

#### Linux (Multiple Package Formats)

PrivateTranscribe now supports multiple Linux package formats for maximum compatibility:

**Available Formats**:
- `.deb` - Debian, Ubuntu, Linux Mint, Pop!_OS
- `.rpm` - Fedora, Red Hat, CentOS, openSUSE
- `.tar.gz` - Universal archive (works on any distro)
- `.flatpak` - Sandboxed cross-distro package
- `AppImage` - Portable single-file executable

**Building Linux Packages**:

```bash
# Build default Linux package formats (AppImage, deb, rpm, tar.gz)
npm run build:linux

# Find packages in dist/:
# - PrivateTranscribe-x.x.x-linux-x64.AppImage
# - PrivateTranscribe-x.x.x-linux-x64.deb
# - PrivateTranscribe-x.x.x-linux-x64.rpm
# - PrivateTranscribe-x.x.x-linux-x64.tar.gz
```

**Optional: Building Flatpak** (requires additional setup):

```bash
# Install Flatpak build tools
sudo apt install flatpak flatpak-builder  # Debian/Ubuntu
# OR
sudo dnf install flatpak flatpak-builder  # Fedora/RHEL

# Add Flathub repository and install runtime
flatpak remote-add --user --if-not-exists flathub https://flathub.org/repo/flathub.flatpakrepo
flatpak install --user -y flathub org.freedesktop.Platform//24.08 org.freedesktop.Sdk//24.08

# Add "flatpak" to linux.target in electron-builder.json, then build
npm run build:linux
```

**Installation Examples**:

```bash
# Debian/Ubuntu
sudo apt install ./dist/PrivateTranscribe-*-linux-x64.deb

# Fedora/RHEL
sudo dnf install ./dist/PrivateTranscribe-*-linux-x64.rpm

# Universal tar.gz (no root required)
tar -xzf dist/PrivateTranscribe-*-linux-x64.tar.gz
cd PrivateTranscribe-*/
./PrivateTranscribe

# Flatpak
flatpak install --user ./dist/PrivateTranscribe-*-linux-x64.flatpak

# AppImage (existing method)
chmod +x dist/PrivateTranscribe-*.AppImage
./dist/PrivateTranscribe-*.AppImage
```

**Optional Dependencies for Automatic Paste**:

The clipboard paste feature requires platform-specific tools:

**X11 (Traditional Linux Desktop)**:
```bash
# Debian/Ubuntu
sudo apt install xdotool

# Fedora/RHEL
sudo dnf install xdotool

# Arch
sudo pacman -S xdotool
```

**Wayland (Modern Linux Desktop)**:

Choose **one** of the following paste tools:

**Option 1: wtype** (requires virtual keyboard protocol support)
```bash
# Debian/Ubuntu
sudo apt install wtype

# Fedora/RHEL
sudo dnf install wtype

# Arch
sudo pacman -S wtype
```

**Option 2: ydotool** (works on more compositors, requires daemon)
```bash
# Debian/Ubuntu
sudo apt install ydotool
sudo systemctl enable --now ydotoold

# Fedora/RHEL
sudo dnf install ydotool
sudo systemctl enable --now ydotoold

# Arch
sudo pacman -S ydotool
sudo systemctl enable --now ydotoold
```

**Terminal Detection** (Optional - for KDE Wayland users):
```bash
# On KDE Wayland, kdotool enables automatic terminal detection
# to paste with Ctrl+Shift+V instead of Ctrl+V
sudo apt install kdotool  # Debian/Ubuntu
sudo dnf install kdotool  # Fedora/RHEL
sudo pacman -S kdotool    # Arch
```

> ℹ️ **Note**: PrivateTranscribe automatically tries paste tools in this order: `wtype` → `ydotool` → `xdotool` (for XWayland apps). If no paste tool is installed, text will still be copied to the clipboard - you'll just need to paste manually with Ctrl+V.

> ⚠️ **ydotool Requirements**: The `ydotoold` daemon must be running for ydotool to work. Start it manually with `sudo ydotoold &` or enable the systemd service as shown above.

**GNOME Wayland Global Hotkeys**:

On GNOME Wayland, Electron's standard global shortcuts don't work due to Wayland's security model. PrivateTranscribe automatically uses native GNOME keyboard shortcuts via D-Bus and gsettings:

- Hotkeys are registered as GNOME custom shortcuts (visible in Settings → Keyboard → Shortcuts)
- Default hotkey is `Alt+R` (backtick not supported on GNOME Wayland)
- **Push-to-talk mode is not available** on GNOME Wayland (only tap-to-talk)
- Falls back to X11/XWayland shortcuts if GNOME integration fails
- No additional dependencies required - uses `dbus-next` npm package

> ℹ️ **GNOME Wayland Limitation**: GNOME system shortcuts only fire a single toggle event (no key-up detection), so push-to-talk mode cannot work. The app automatically uses tap-to-talk mode on GNOME Wayland.

> 🔒 **Flatpak Security**: The Flatpak package includes sandboxing with explicit permissions for microphone, clipboard, and file access. See [electron-builder.json](electron-builder.json) for the complete permission list.

### Building for Distribution

For maintainers who need to distribute signed builds:

```bash
# Requires code signing certificates and notarization setup
npm run build:mac    # macOS (requires Apple Developer account)
npm run build:win    # Windows (requires code signing cert)
npm run build:linux  # Linux
```

### First Time Setup

1. **Choose Processing Method**:
   - **Local Processing**: Download Whisper models for completely private transcription
   - **Cloud Processing**: Use OpenAI's API for faster transcription (requires API key)

2. **Grant Permissions**:
   - **Microphone Access**: Required for voice recording
   - **Accessibility Permissions**: Required for automatic text pasting (macOS)

3. **Name Your Agent**: Give your AI assistant a personal name (e.g., "Assistant", "Jarvis", "Alex")
   - Makes interactions feel more natural and conversational
   - Helps distinguish between giving commands and regular dictation
   - Can be changed anytime in settings

4. **Configure Global Hotkey**: Default is backtick (`) but can be customized

## Usage

### Basic Dictation
1. **Start the app** - A small draggable panel appears on your screen
2. **Press your hotkey** (default: backtick `) - Start dictating (panel shows recording animation)
3. **Press your hotkey again** - Stop dictation and begin transcription (panel shows processing animation)
4. **Text appears** - Transcribed text is automatically pasted at your cursor location
5. **Drag the panel** - Click and drag to move the dictation panel anywhere on your screen

### Control Panel
- **Access**: Right-click the tray icon (macOS) or through the system menu
- **Configure**: Choose between local and cloud processing
- **History**: View, copy, and delete past transcriptions
- **Models**: Download and manage local Whisper models
- **Storage Cleanup**: Remove downloaded Whisper models from cache to reclaim space
- **Settings**: Configure API keys, customize hotkeys, and manage permissions

### Uninstall & Cache Cleanup
PrivateTranscribe now has a **two-level uninstall story**:

- **Normal uninstall**: use the OS/package-manager uninstall flow first.
- **Full cleanup**: use the platform helper below if you want to remove leftover data, caches, logs, and legacy DictateVoice paths too.

**Normal uninstall**
- **Windows**: uninstall from **Settings → Apps**. The NSIS uninstaller automatically removes PrivateTranscribe model caches.
- **macOS**: remove **PrivateTranscribe.app** from Applications (or the install location).
- **Linux**: uninstall with the same format you installed with (`apt`, `dnf`, `rpm`, `flatpak`, etc.). Package uninstall removes bundled app files; cache cleanup may vary by format.

**Full cleanup helpers**
- **macOS**: `npm run uninstall:full:mac`
- **Linux**: `npm run uninstall:full:linux`
- **Windows**: `npm run uninstall:full:windows`

These helpers remove app data, caches, logs, and old **DictateVoice** leftovers. They are intentionally separate from the normal uninstall path so user data is not deleted silently.

**In-app cleanup**
- Use *Settings → General → Local Model Storage → Remove Downloaded Models* to clear cached local models without uninstalling the app.

### Agent Naming & AI Processing
Once you've named your agent during setup, you can interact with it using multiple AI providers:

**🎯 Agent Commands** (for AI assistance):
- "Hey [AgentName], make this more professional"
- "Hey [AgentName], format this as a list"
- "Hey [AgentName], write a thank you email"
- "Hey [AgentName], convert this to bullet points"

**🤖 AI Provider Options**:
- **OpenAI**: GPT-5, GPT-4.1, o-series reasoning models
- **Anthropic**: Claude Opus 4.5, Sonnet 4.5, Haiku 4.5
- **Google**: Gemini 2.5 Pro/Flash/Flash-Lite
- **Groq**: Ultra-fast Llama and Mixtral inference
- **Local**: Qwen, LLaMA, Mistral via llama.cpp

**📝 Regular Dictation** (for normal text):
- "This is just normal text I want transcribed"
- "Meeting notes: John mentioned the quarterly report"
- "Dear Sarah, thank you for your help"

The AI automatically detects when you're giving it commands versus dictating regular text, and removes agent name references from the final output.

### Custom Dictionary
Improve transcription accuracy for specific words, names, or technical terms:

1. **Access Settings**: Open Control Panel → Settings → Custom Dictionary
2. **Add Words**: Enter words, names, or phrases that are frequently misrecognized
3. **How It Works**: Words are provided as context hints to the speech recognition model

**Examples of words to add**:
- Uncommon names (e.g., "Sergey", "Xanthe")
- Technical jargon (e.g., "Kubernetes", "OAuth")
- Brand names (e.g., "PrivateTranscribe", "whisper.cpp")
- Domain-specific terms (e.g., "amortization", "polymerase")

### Processing Options
- **Local Processing**:
  - Install Whisper automatically through the Control Panel
  - Download models: tiny (fastest), base (recommended), small, medium, large (best quality)
  - Complete privacy - audio never leaves your device
- **Cloud Processing**:
  - Requires OpenAI API key
  - Faster processing
  - Uses OpenAI's Whisper API

## Project Structure

```
open-whispr/
├── main.js              # Electron main process & IPC handlers
├── preload.js           # Electron preload script & API bridge
├── setup.js             # First-time setup script
├── package.json         # Dependencies and scripts
├── env.example          # Environment variables template
├── CHANGELOG.md         # Project changelog
├── src/
│   ├── App.jsx          # Main dictation interface
│   ├── main.jsx         # React entry point
│   ├── index.html       # Vite HTML template
│   ├── index.css        # Tailwind CSS v4 configuration
│   ├── vite.config.js   # Vite configuration
│   ├── components/
│   │   ├── ControlPanel.tsx     # Settings and history UI
│   │   ├── OnboardingFlow.tsx   # First-time setup wizard
│   │   ├── SettingsPage.tsx     # Settings interface
│   │   ├── ui/                  # shadcn/ui components
│   │   │   ├── button.tsx
│   │   │   ├── card.tsx
│   │   │   ├── input.tsx
│   │   │   ├── LoadingDots.tsx
│   │   │   ├── Toast.tsx
│   │   │   ├── toggle.tsx
│   │   │   └── tooltip.tsx
│   │   └── lib/
│   │       └── utils.ts         # Utility functions
│   ├── services/
│   │   └── ReasoningService.ts  # Multi-provider AI processing (OpenAI/Anthropic/Gemini)
│   ├── utils/
│   │   └── agentName.ts         # Agent name management utility
│   └── components.json          # shadcn/ui configuration
└── assets/                      # App icons and resources
```

## Technology Stack

- **Frontend**: React 19, TypeScript, Tailwind CSS v4
- **Build Tool**: Vite with optimized Tailwind plugin
- **Desktop**: Electron 36 with context isolation
- **UI Components**: shadcn/ui with Radix primitives
- **Database**: better-sqlite3 for local transcription storage
- **Speech-to-Text**: OpenAI Whisper (whisper.cpp) + NVIDIA Parakeet (sherpa-onnx) for local, OpenAI API for cloud
- **Icons**: Lucide React for consistent iconography

## Development

### Scripts

- `npm run dev` - Start development with hot reload
- `npm run start` - Start production build
- `npm run setup` - First-time setup (creates .env file)
- `npm run build:renderer` - Build the React app only
- `npm run download:whisper-cpp` - Download whisper.cpp for the current platform
- `npm run download:whisper-cpp:all` - Download whisper.cpp for all platforms
- `npm run download:llama-server` - Download llama.cpp server for local LLM inference
- `npm run download:llama-server:all` - Download llama.cpp server for all platforms
- `npm run download:sherpa-onnx` - Download sherpa-onnx for Parakeet local transcription
- `npm run download:sherpa-onnx:all` - Download sherpa-onnx for all platforms
- `npm run compile:native` - Compile native helpers (Globe key listener for macOS, key listener for Windows)
- `npm run build` - Full build with signing (requires certificates)
- `npm run build:mac` - macOS build with signing
- `npm run build:win` - Windows build with signing
- `npm run build:linux` - Linux build
- `npm run pack` - Build without signing (for personal use)
- `npm run dist` - Build and package with signing
- `npm run lint` - Run ESLint
- `npm run format` - Format code with Prettier
- `npm run clean` - Clean build artifacts
- `npm run preview` - Preview production build

### Architecture

The app consists of two main windows:
1. **Main Window**: Minimal overlay for dictation controls
2. **Control Panel**: Full settings and history interface

Both use the same React codebase but render different components based on URL parameters.

### Key Components

- **main.js**: Electron main process, IPC handlers, database operations
- **preload.js**: Secure bridge between main and renderer processes
- **App.jsx**: Main dictation interface with recording controls
- **ControlPanel.tsx**: Settings, history, and model management
- **src/helpers/whisper.js**: whisper.cpp integration for local processing
- **better-sqlite3**: Local database for transcription history

### Tailwind CSS v4 Setup

This project uses the latest Tailwind CSS v4 with:
- CSS-first configuration using `@theme` directive
- Vite plugin for optimal performance
- Custom design tokens for consistent theming
- Dark mode support with `@variant`

## Building

The build process creates a single executable for your platform:

```bash
# Development build
npm run pack

# Production builds
npm run dist           # Current platform
npm run build:mac      # macOS DMG + ZIP
npm run build:win      # Windows NSIS + Portable
npm run build:linux    # AppImage + DEB
```

Note: build/pack/dist scripts automatically download whisper.cpp, llama-server, and sherpa-onnx for the current platform. For multi-platform packaging from one host, run the `:all` variants first (`npm run download:whisper-cpp:all`, `npm run download:llama-server:all`, `npm run download:sherpa-onnx:all`).

## Configuration

### Environment Variables

Create a `.env` file in the root directory (or use `npm run setup`):

```env
# OpenAI API Configuration (optional - only needed for cloud processing)
OPENAI_API_KEY=your_openai_api_key_here

# Optional: Customize the Whisper model
WHISPER_MODEL=whisper-1

# Optional: Set language for better transcription accuracy
LANGUAGE=

# Optional: Anthropic API Configuration
ANTHROPIC_API_KEY=your_anthropic_api_key_here

# Optional: Google Gemini API Configuration
GEMINI_API_KEY=your_gemini_api_key_here

# Optional: Groq API Configuration (ultra-fast inference)
GROQ_API_KEY=your_groq_api_key_here

# Optional: Debug mode
DEBUG=false

# Optional (privacy): disable all active-window context capture (window title + focused UI text)
# Useful for stricter privacy, or if AV/EDR blocks UI Automation / window inspection.
PRIVOCA_DISABLE_CONTEXT_CAPTURE=false

# Optional (privacy, Windows-only): disable UI Automation (UIA) focused-element capture while
# still allowing basic window title/app context when available.
PRIVOCA_DISABLE_WINDOWS_UIA=false

# Optional (privacy, Windows-only): disable the UIA TextPattern fallback.
# TextPattern can expose richer document text (still hard-limited + sanitized), so some
# environments may prefer to fully disable it.
PRIVOCA_DISABLE_WINDOWS_UIA_TEXTPATTERN=false

# Optional (privacy): tune how much context can ever be captured.
# These limits apply BEFORE the app uses the text in prompts, and captured text is still
# passed through sanitization.
PRIVOCA_CONTEXT_MAX_CHARS_WINDOW_TITLE=512
PRIVOCA_CONTEXT_MAX_CHARS_UIA_TEXT=512

# Optional (privacy): add your own sensitive app/window patterns (comma-separated).
# Supports both substrings and regex literals like /okta/i.
# Matching contexts are blocked (no capture).
PRIVOCA_CONTEXT_SENSITIVE_APP_PATTERNS=""
```

### Local Whisper Setup

For local processing, PrivateTranscribe uses OpenAI's Whisper model via whisper.cpp - a high-performance C++ implementation:

1. **Bundled Binary**: whisper.cpp is bundled with the app for all platforms
2. **GGML Models**: Downloads optimized GGML models on first use to `~/.cache/Privoca/whisper-models/`
3. **No Dependencies**: No Python or other runtime required

**System Fallback**: If the bundled binary fails, install via package manager:
- macOS: `brew install whisper-cpp`
- Linux: Build from source at https://github.com/ggml-org/whisper.cpp

**From Source**: When running locally (not a packaged build), download the binary with `npm run download:whisper-cpp` so `resources/bin/` has your platform executable.

**Requirements**:
- Sufficient disk space for models (75MB - 3GB depending on model)

**Upgrading from Python-based version**: If you previously used the Python-based Whisper, you'll need to re-download models in GGML format. You can safely delete the old Python environment (`~/.PrivateTranscribe/python/`) and PyTorch models (`~/.cache/whisper/`) to reclaim disk space.

### Local Parakeet Setup (Alternative)

PrivateTranscribe also supports NVIDIA Parakeet models via sherpa-onnx - a fast alternative to Whisper:

1. **Bundled Binary**: sherpa-onnx is bundled with the app for all platforms
2. **INT8 Quantized Models**: Efficient CPU inference
3. **Models stored in**: `~/.cache/Privoca/parakeet-models/`

**Available Models**:
- `parakeet-tdt-0.6b-v3`: Multilingual (25 languages), ~680MB

**When to use Parakeet vs Whisper**:
- **Parakeet**: Best for speed-critical use cases or lower-end hardware
- **Whisper**: Best for quality-critical use cases or when you need specific model sizes

### Customization

- **Hotkey**: Change in the Control Panel (default: backtick `) - fully customizable
- **Panel Position**: Drag the dictation panel to any location on your screen`
- **Processing Method**: Choose local or cloud in Control Panel
- **Whisper Model**: Select quality vs speed in Control Panel
- **UI Theme**: Edit CSS variables in `src/index.css`
- **Window Size**: Adjust dimensions in `main.js`
- **Database**: Transcriptions stored in user data directory

## Contributing

We welcome contributions! Please follow these steps:

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

### Development Guidelines

- Run `npm run lint` before committing
- Follow the existing code style
- Update documentation as needed
- Test on your target platform before submitting
## Security

PrivateTranscribe is designed with privacy and security in mind:

- **Local Processing Option**: Keep your voice data completely private
- **No Analytics**: We don't collect any usage data or telemetry
- **Open Source**: All code is available for review
- **Secure Storage**: API keys are stored securely in your system's keychain/credential manager
- **Minimal Permissions**: Only requests necessary permissions (microphone, accessibility)

## Troubleshooting

### Common Issues

1. **Microphone permissions**: Grant permissions in System Preferences/Settings
2. **Accessibility permissions (macOS)**: Required for automatic text pasting
   - Go to System Settings → Privacy & Security → Accessibility
   - Add PrivateTranscribe and enable the checkbox
   - Use "Fix Permission Issues" in Control Panel if needed
3. **API key errors** (cloud processing only): Ensure your OpenAI API key is valid and has credits
   - Set key through Control Panel or .env file
   - Check logs for "OpenAI API Key present: Yes/No"
4. **Local Whisper issues**:
   - whisper.cpp is bundled with the app
   - If bundled binary fails, install via `brew install whisper-cpp` (macOS)
   - Check available disk space for models
5. **Global hotkey conflicts**: Change the hotkey in the Control Panel - any key can be used
   - GNOME Wayland: Hotkeys are registered via gsettings; check Settings → Keyboard → Shortcuts for conflicts
6. **Text not pasting**:
   - macOS: Check accessibility permissions (System Settings → Privacy & Security → Accessibility)
   - Linux X11: Install `xdotool`
   - Linux Wayland: Install `wtype` or `ydotool` (ensure `ydotoold` daemon is running)
   - All platforms: Text is always copied to clipboard - use Ctrl+V (Cmd+V on macOS) to paste manually
7. **Panel position**: If the panel appears off-screen, restart the app to reset position

### Getting Help

- Check the [Issues](https://github.com/PrivateTranscribe/PrivateTranscribe/issues) page
- Review the console logs for debugging information
- For local processing: Ensure whisper.cpp is accessible and models are downloaded
- For cloud processing: Verify your OpenAI API key and billing status
- Check the Control Panel for system status and diagnostics

### Performance Tips

- **Local Processing**: Use "base" model for best balance of speed and accuracy
- **Cloud Processing**: Generally faster but requires internet connection
- **Model Selection**: tiny (fastest) → base (recommended) → small → medium → large (best quality)
- **Permissions**: Ensure all required permissions are granted for smooth operation

## FAQ

**Q: Is PrivateTranscribe really free?**
A: Yes! PrivateTranscribe is open source and free to use. You only pay for OpenAI API usage if you choose cloud processing.

**Q: Which processing method should I use?**
A: Use local processing for privacy and offline use. Use cloud processing for speed and convenience.

**Q: Can I use this commercially?**
A: Yes! The MIT license allows commercial use.

**Q: How do I change the hotkey?**
A: Open the Control Panel (right-click tray icon) and go to Settings. You can set any key as your hotkey.

**Q: Is my data secure?**
A: With local processing, your audio never leaves your device. With cloud processing, audio is sent to OpenAI's servers (see their privacy policy).

**Q: What languages are supported?**
A: PrivateTranscribe supports 58 languages including English, Spanish, French, German, Chinese, Japanese, and more. Set your preferred language in the .env file or use auto-detect.

## Project Status

PrivateTranscribe is actively maintained and ready for production use. Current version: 1.3.4

- ✅ Core functionality complete
- ✅ Cross-platform support (macOS, Windows, Linux)
- ✅ Local and cloud processing
- ✅ Multi-provider AI (OpenAI, Anthropic, Gemini, Groq, Local)
- ✅ Compound hotkey support
- ✅ Windows Push-to-Talk with native key listener
- ✅ Custom dictionary for improved transcription accuracy
- ✅ Optional active app/window context capture for improved reasoning (privacy-first, stored locally)
- ✅ NVIDIA Parakeet support via sherpa-onnx
- ✅ GNOME Wayland native global shortcuts

## Acknowledgments

- **[OpenAI Whisper](https://github.com/openai/whisper)** - The speech recognition model that powers both local and cloud transcription
- **[whisper.cpp](https://github.com/ggerganov/whisper.cpp)** - High-performance C++ implementation of Whisper for local processing
- **[NVIDIA Parakeet](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3)** - Fast ASR model for efficient local transcription
- **[sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx)** - Cross-platform ONNX runtime for Parakeet model inference
- **[Electron](https://www.electronjs.org/)** - Cross-platform desktop application framework
- **[React](https://react.dev/)** - UI component library
- **[shadcn/ui](https://ui.shadcn.com/)** - Beautiful UI components built on Radix primitives
- **[llama.cpp](https://github.com/ggerganov/llama.cpp)** - Local LLM inference for AI-powered text processing
