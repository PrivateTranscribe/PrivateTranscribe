# PrivateTranscribe

Private, local voice dictation for Windows. Speak to type. Local Whisper by default, so the recording stays on your PC. Cloud transcription is optional.

**Download** PrivateTranscribe for Windows from [privatetranscribe.com](https://privatetranscribe.com/?utm_source=github&utm_medium=readme).

PrivateTranscribe began as a private copy of [OpenWhispr](https://github.com/OpenWhispr/openwhispr) (MIT) in early 2026 and has been rewritten since. The OpenWhispr notice ships with every build, see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Features

- **Local speech-to-text** via Whisper (tiny, base, small, medium, large, turbo)
- **Global hotkey** — dictate from anywhere, paste directly at cursor
- **AI text enhancement** — optional post-processing via OpenAI, Anthropic, Gemini, Groq, or local models
- **Correction Memory** — learns from your edits to improve future output
- **Custom dictionary** — add names, technical terms, domain jargon
- **Push-to-talk** — native low-level Windows key listener
- **Control Panel** — transcription history, settings, model management
- **Privacy-first** — with a local model, audio stays on your device

[SECURITY.md](.github/SECURITY.md) explains how to report a vulnerability, what the app can do on your PC and what leaves it.

## Requirements

- Windows 10 or later

## Development

You need Node.js 22. [CONTRIBUTING.md](.github/CONTRIBUTING.md) has the full setup and the checks to run before a pull request.

```bash
npm ci
npm run dev
```

Most of the code is written with AI coding agents, mainly Claude Code, directed and tested by one developer.

## Building

```bash
npm run build:win    # Windows installer + portable
npm run pack         # Unsigned build for local testing
```

Official releases are built and signed by GitHub Actions.

Copies you build yourself do not check for app updates or send usage events.

## Contributing

Bug fixes and bug reports are welcome. Start with [CONTRIBUTING.md](.github/CONTRIBUTING.md), and see [SUPPORT.md](.github/SUPPORT.md) for where to ask questions.

## License

Copyright © 2026 Julsgaard Products.

PrivateTranscribe is free software under the GNU General Public License, version 3 or (at your option) any later version. See [LICENSE](LICENSE).

The whole history of this repository is released under the same licence, including the commits from before the code was opened, whose LICENSE file said otherwise. OpenWhispr's MIT notice in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) covers every commit, and the third-party parts listed there keep their own licences.
