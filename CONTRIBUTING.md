# Contributing to PrivateTranscribe

Thank you for helping. This page takes you from a fresh clone to a pull request.

## What helps

- Bug reports with clear steps and a log excerpt. Use the [bug report form](https://github.com/PrivateTranscribe/PrivateTranscribe/issues/new?template=bug_report.yml).
- Small fixes, especially issues labelled `good first issue`.
- New features start as an idea in [Discussions](https://github.com/PrivateTranscribe/PrivateTranscribe/discussions/categories/ideas) or as an issue. We agree on the change there before anyone writes code.

Questions go where [SUPPORT.md](SUPPORT.md) says.

## Quick start on Windows 10 or 11

You need [Git](https://git-scm.com/) and [Node.js 22 LTS](https://nodejs.org/).

1. Use Command Prompt or Git Bash. In PowerShell, type `npm.cmd` instead of `npm`, because the default execution policy blocks `npm.ps1`.
2. If PrivateTranscribe is installed and running, right-click its tray icon and choose **Exit PrivateTranscribe**. The installed app and your development copy share `%APPDATA%\PrivateTranscribe` and the lock that allows only one copy to run. While the installed app runs, the development app closes and the installed one comes forward instead.
3. Fork the repository on GitHub, then clone your fork, install and start.

   ```bash
   git clone https://github.com/YOUR-NAME/PrivateTranscribe.git
   cd PrivateTranscribe
   npm ci
   npm run dev
   ```

   The first `npm run dev` downloads the Whisper engine into `resources/bin`. Later runs reuse it.

4. A warning that the Windows key listener could not be built is expected. Push-to-talk is then off. Dictation with a tap of the hotkey and the rest of the app work.

## Push-to-talk (optional)

Push-to-talk needs the native key listener, which you compile yourself.

1. Install [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) with the **Desktop development with C++** workload.
2. Open **x64 Native Tools Command Prompt** from the Start menu, go to your clone and run `npm run compile:winkeys`.

## Before you open a pull request

Run these from the repository root.

```bash
npm run format
npm test
npm run build:renderer
```

`npm run build:renderer` matters when you changed the UI.

End-to-end tests start the real app. Run only the spec you touched, for example `npm run test:e2e -- tests/e2e/settings-search.spec.ts`. Keep your hands off the keyboard and mouse while it runs, because some specs use the clipboard and send key presses.

UI changes need before-and-after screenshots in the pull request. Read [docs/DESIGN_TASTE_GUIDE.md](docs/DESIGN_TASTE_GUIDE.md) before you change a screen.

## Pull requests

- One change per pull request, from a branch on your fork.
- Link the issue it fixes and fill in the pull request template.
- CI runs once a maintainer approves the run, and it must pass before we merge.

## AI coding agents

Contributions written with AI coding agents such as Claude Code or Codex are welcome. Say so in the pull request. You answer for every line, so read it, run it and understand it before you submit. Your agent reads `CLAUDE.md` or `AGENTS.md`, which point it back to this page.

## Licence

PrivateTranscribe is licensed under GPL-3.0-or-later. Your contribution comes in under the same licence, as GitHub's terms of service already provide. There is no contributor licence agreement to sign.

After you add, remove or update a dependency, run `npm run notices` and commit the updated `THIRD_PARTY_NOTICES.md`. A new file in `resources/bin` also needs an entry in `resources/third-party/components.json`, or the Windows build stops.

## Security

Report a vulnerability privately through the repository's **Security** tab, as [SECURITY.md](SECURITY.md) describes. Keep it out of issues, pull requests and discussions.

## Packaging (optional)

`npm run pack` builds an unsigned app in `dist`. It copies the Visual C++ runtime next to the bundled engines, so it needs Visual Studio Build Tools with the C++ workload or a recent Visual C++ 2015-2022 x64 redistributable.

## Finding your way around

The tables in [CLAUDE.md](CLAUDE.md) map each part of the app to its files. Start with "Key Module Locations" and "Control Panel Page Architecture".
