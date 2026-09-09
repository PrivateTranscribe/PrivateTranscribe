# PrivateTranscribe

Private, local voice dictation for Windows. Speak to type. Local Whisper by default, so the recording stays on your PC. Cloud transcription is optional.

PrivateTranscribe began as a private copy of [OpenWhispr](https://github.com/OpenWhispr/openwhispr) (MIT) in early 2026 and has been rewritten since. The OpenWhispr notice ships with every build, see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Features

- **Local speech-to-text** via Whisper (tiny, base, small, medium, large, turbo)
- **NVIDIA Parakeet** support for fast local transcription (25 languages)
- **Global hotkey** — dictate from anywhere, paste directly at cursor
- **AI text enhancement** — optional post-processing via OpenAI, Anthropic, Gemini, Groq, or local models
- **Correction Memory** — learns from your edits to improve future output
- **Custom dictionary** — add names, technical terms, domain jargon
- **Push-to-talk** — native low-level Windows key listener
- **Control Panel** — transcription history, settings, model management
- **Privacy-first** — all audio stays on your device

## Requirements

- Windows 10 or later
- Node.js 18+

## Development

```bash
npm install
npm run dev
```

## Building

```bash
npm run build:win    # Windows installer + portable
npm run pack         # Unsigned build for local testing
```

Releases are deployed automatically via GitHub Actions when pushing to the `production` branch.

## License

Copyright © 2026 Kristian Julsgaard. All rights reserved.
This software is proprietary and not licensed for redistribution or modification.
