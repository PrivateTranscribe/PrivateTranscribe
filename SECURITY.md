# Security

## Reporting a vulnerability

Please report security problems privately. On GitHub, open this repository's **Security** tab and choose **Report a vulnerability**. Do not use a public issue, pull request or discussion.

A useful report includes:

- the PrivateTranscribe version and the Windows version you tested on
- what an attacker gains, and what they need first, such as a local account, a crafted file or a place on your network
- steps to reproduce, or a proof of concept
- the file or component involved, if you know it

We discuss each report with you in its private advisory. We do not promise a response time. Please keep the details private until a fix has shipped.

Bugs in third-party parts such as Electron, whisper.cpp, llama.cpp, sherpa-onnx or the Claude Code CLI belong with their maintainers. Tell us as well if the way this app uses one of them is unsafe.

## Supported versions

We fix security problems in the latest release only. Official builds learn about new releases from the update feed, and you choose when to download one. A copy you built from source does not update itself, so rebuild it from the latest source.

## What the app can do on your PC

PrivateTranscribe runs as your Windows user, without administrator rights. These are the parts that reach furthest.

**Push-to-talk key listener.** `windows-key-listener.exe` installs a low-level keyboard hook, plus a mouse hook when your hotkey is a mouse side button. The hook sees every key press on your desktop. It compares each one with your hotkey and tells the app only `READY`, `KEY_DOWN` or `KEY_UP`. It does not store, log or send keystrokes. It passes every event on to Windows unchanged and presses no keys itself. It runs while your dictation hotkey is active.

**Pasting.** The app saves your clipboard (text, HTML, RTF and images), puts the dictated text on it and runs `windows-fast-paste.exe`. The helper reads the class name and program name of the window in front, never its title. It presses Ctrl+V, or Ctrl+Shift+V in a terminal, after briefly releasing any modifier keys you still hold. To confirm the paste, it reads the focused field through UI Automation and looks for the dictated text. What it reads stays inside the helper. After a confirmed paste the app puts your clipboard back. If the helper is missing or cannot confirm the paste, the dictated text stays on the clipboard.

**Read Aloud.** Pressing the Read Aloud key makes a bundled PowerShell script send Ctrl+C to the window in front. The app reads the copied text and then puts your previous clipboard text back. If nothing was copied, it reads the text already on the clipboard. The Kokoro model generates the voice on your PC. For the in-place highlight, a second bundled script uses UI Automation to read the selection, where it sits on screen and the title of its window. It only reads. A transparent window that ignores the mouse and never takes focus draws the outline. Both scripts run with `-ExecutionPolicy Bypass`.

**Experimental features (off by default).** Converse, Agent mode and the Action Engine are hidden until you turn on **Experimental features** in Settings. While it is off, their pages are gone from the sidebar, a saved Agent mode setting is ignored and no voice trigger runs.

**Action Engine (beta).** The Action Engine runs actions you create when a dictation matches a trigger phrase. There are four kinds:

- **Shell command** runs one program with its arguments as your Windows user. It uses `execFile` rather than a shell and kills the program if it is still running after 10 seconds. The program name may not contain `|`, `&`, `;`, `<`, `>`, `$`, a backtick or a line break. The program can still be `cmd.exe` or PowerShell, so a shell action can do anything you can.
- **Open URL** opens an `http` or `https` address in your default browser.
- **Open application** opens an absolute local path with its default handler, so an `.exe` runs. URLs and network paths are refused.
- **Switch dictation mode** changes the dictation mode inside the app.

Voice triggers work only while **Experimental features** and **Beta features** are on in Settings, the switch on the Action Engine page is on and the action is enabled. The app ships with no actions. Nothing asks you to confirm a run. When the final text of a dictation matches an enabled trigger, every matching action runs and the text is not pasted. The default match mode, Contains, fires when the phrase appears anywhere in a dictation. An action triggered by voice cannot run again within 2 seconds, and Agent mode dictations never trigger actions. The play button next to an enabled action runs it at once. Each run is saved in the app's local database, with the program's output and, for voice runs, the dictated text.

**Converse.** Converse starts the Claude Code CLI (`claude`) installed on your PC, under your Windows account, in the project folder you choose. The app finds `claude` by its full path in your PATH folders, never in the project folder, and runs the permission relay with its own bundled runtime. Claude Code loads settings, MCP servers and instructions from the project folder itself. When the folder holds any of those files, Converse lists them and starts only after you choose **Trust and start**, and it asks again when one of them changes or a new one appears. It runs with your own Claude Code login, settings, permission rules and MCP servers, so tools your settings already allow run without a question. The app adds no permission rules and passes no flag that skips permission checks. When Claude Code wants a tool your settings do not allow, it asks the app through `--permission-prompt-tool`. The question appears on the Converse page with **Allow** and **Deny**, showing the full request, and a spoken line asks you to answer it there. A question nobody answers within 55 seconds is denied. So is a malformed request, or one without the session's random token.

**Agent mode (off by default).** Agent mode turns your normal dictation key into a coding-prompt key and adds no second key listener. By default it rewrites the transcript through the Claude Code CLI in print mode, using your Claude Code login, with built-in tools, MCP servers, settings files and session saving switched off. If you end with "send", the paste helper also presses Enter, but only when it saw the paste land or could not observe the field.

**Voice call mute (off by default).** While you dictate, the app holds the push-to-mute key you set for your voice app, and only when a known voice app is using the microphone. To know that, `windows-mic-watch.exe` runs whenever the app does and checks once a second which programs hold a microphone session. It reads process names, never window titles.

**Local servers.** The app starts these only when a feature needs them:

- `whisper-server` (local Whisper) listens on 127.0.0.1, on a port from 8178 to 8199. It has no password option, so every route sits under a random path the app picks at each start, and any other address returns 404.
- `llama-server` (local AI models) listens on 127.0.0.1, on a port from 8200 to 8220. It requires a random key the app creates at each start and hands over in the server's environment, never on its command line. Its slots endpoint and web page are off.
- The Converse permission relay listens on 127.0.0.1, on a port Windows picks, and rejects requests without the session token.
- Kokoro, the voice for Read Aloud and Converse, runs in an Electron utility process and opens no network port.

The Parakeet engine is retired. Its sherpa-onnx WebSocket server would listen on every network interface with no password, so the app no longer starts it.

A web page in your browser cannot use these servers, because it cannot learn the path or the key. A program already running under your Windows account can read both from the server processes.

## What leaves your PC

- **Audio** leaves your PC only for a cloud transcription service you set up with your own API key or endpoint (OpenAI, Groq or a custom one). Your custom dictionary words go with it as a hint.
- **Text** goes to an AI provider only when you use AI enhancement, a beta, with a cloud provider you pick (OpenAI, Anthropic, Google Gemini, Groq or a custom endpoint). With a local model it stays on your PC. If you also turn on LLM Context Enhancement in the Smart Context beta, the request includes the active window's app and process name, its title and the focused field's text, plus an excerpt of the open file if you turn on Include active file content. The app reads that file only when the active app is a known code editor, finds it by the name in the window title, and looks only in your user folder.
- **Converse, Agent mode and the Claude Code option in AI enhancement** pass your words to the Claude Code CLI on your PC. The CLI sends them on using your own Claude Code login and configuration.
- **API keys** are stored in your Windows user profile. The app encrypts them with Electron's `safeStorage`, or saves them in a plain `.env` file in the same folder when Windows cannot encrypt them. The settings screen also keeps a copy in the app's local storage, which is not encrypted.
- **Feedback** is sent only when you submit the feedback form. It carries your message, any contact details and screenshots you add, the app version, a random install ID and basic machine specs.
- **Updates and usage events.** Official builds check privatetranscribe.com's update feed for app updates and, if you agree, send usage events under a random install ID. Copies built from source do neither.
- **Downloads** happen when you ask for them. Models come from Hugging Face or GitHub, and the GPU engine comes from updates.privatetranscribe.com. The exception is a GPU engine you installed earlier, which the app downloads again at startup when it expects a newer version. To show whether a newer engine exists, the Dashboard and Settings also fetch a small version file from updates.privatetranscribe.com. Model downloads are checked against a pinned SHA-256 before use. The GPU engine is not checked yet, because its current version was published without a recorded hash.
- **Crash dumps and debug logs** stay on your PC. Crash dumps are never uploaded.
