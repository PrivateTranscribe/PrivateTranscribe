# Local Whisper Setup

PrivateTranscribe transcribes locally with whisper.cpp by default. With a local model, your audio stays on your PC.

## Quick Start

1. Open the **Control Panel**: click the tray icon, or right-click it and choose **Open PrivateTranscribe**
2. Open **Dictation** in the sidebar
3. Under **Speech model**, choose local transcription
4. Click **Download** on a model. Turbo is the recommended default; Base suits older or slower PCs

Clicking the overlay starts and stops dictation.

## Model Selection

| Model | Download | Notes |
|-------|----------|-------|
| Turbo | 1.6GB | **Recommended.** Best quality for most users, fast and accurate |
| Base | 142MB | Lightweight option for older or slower hardware |
| Tiny | 75MB | Smallest download, lowest quality |
| Small | 466MB | Higher accuracy than Base |
| Small EN TDRZ | 466MB | English only, with speaker turn detection for multi-speaker files |
| Medium | 1.5GB | Near-flagship accuracy |
| Large | 3GB | Highest quality, slowest |

## How It Works

PrivateTranscribe uses whisper.cpp, a high-performance C++ implementation of OpenAI's Whisper model:

1. The whisper.cpp engine is bundled with the app
2. A model is downloaded when you click **Download**, to `%USERPROFILE%\.cache\PrivateTranscribe\whisper-models\`
3. Audio is processed locally using FFmpeg (bundled with the app)

## Requirements

- **Disk Space**: 75MB to 3GB depending on model
- **No additional dependencies required** - whisper.cpp is bundled in packaged builds

## Running From Source

If you're running PrivateTranscribe from a git checkout (not a packaged app), download the whisper.cpp binary first:

```bash
npm run download:whisper-cpp
```

This puts the binary in `resources/bin/`.

## Troubleshooting

### The engine does not start
1. Restart the app
2. Turn on debug logging and look for the whisper-server lines listed in [DEBUG.md](DEBUG.md)

### Transcription Fails
1. Check that Windows lets desktop apps use the microphone
2. Try a smaller model (tiny/base)
3. Check disk space for model downloads

### Slow Performance
1. Use smaller models (tiny or base)
2. Close resource-intensive apps
3. Consider using cloud mode for large files

## Privacy Comparison

| Mode  | Audio Leaves Device | Internet Required | Cost      |
|-------|---------------------|-------------------|-----------|
| Local | No                  | Only for model download | Free |
| Cloud | Yes (to the provider you choose) | Yes      | API usage |
