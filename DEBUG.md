# Debug Mode

Turn on verbose logging to diagnose problems such as "no audio detected" or a failed transcription.

## Turn on debug logging

### Option 1: Command line

Start the app from the folder it is installed in (usually `C:\Program Files\PrivateTranscribe`):

```powershell
& "C:\Program Files\PrivateTranscribe\PrivateTranscribe.exe" --log-level=debug
```

### Option 2: Settings file

Add this line to `%APPDATA%\PrivateTranscribe\.env` and restart the app:

```
PT_LOG_LEVEL=debug
```

A development build (`npm run dev`) also has a **Debug Logging** switch under **Settings → Diagnostics & Data**.

## Log file location

`%APPDATA%\PrivateTranscribe\logs\debug-*.log`

## What gets logged

| Stage | Details |
|-------|---------|
| FFmpeg | Path resolution, permissions, ASAR unpacking |
| Audio Recording | Permission requests, chunk sizes, audio levels |
| Audio Processing | File creation, the whisper-server request, process output |
| IPC | Messages between renderer and main process |

## Common Issues

### "No Audio Detected"
Look for:
- `Microphone Access Denied` → Windows blocks the microphone for desktop apps
- `FFmpeg not available` → Path resolution failed

### Transcription Fails
Look for:
- `Failed to start whisper-server` or `whisper-server spawn failed` → the local engine did not start
- `whisper-server failed readiness check` → the engine started but never answered
- `CUDA binary failed ... falling back to CPU binary` → the GPU engine could not load, so the CPU engine took over
- `Failed to parse Whisper output` → Invalid JSON

### Hotkey / Push-to-Talk Issues
Look for:
- `[WindowsKeyManager] Starting key listener` (confirms the native listener is being used)
- `Windows key listener binary not found` (fallback mode; push-to-talk reliability may be reduced)

Mouse side buttons:
- Use `Mouse4` / `Mouse5` (aka back/forward side buttons).
- When setting the hotkey, click the hotkey field and press the mouse side button.

## Sharing Logs

When reporting issues:
1. Enable debug mode and reproduce the issue
2. Locate the log file
3. Redact any sensitive information
4. Include relevant log sections in your issue report

## Turn Debug Logging Off

Debug logging is off by default. To turn it off again:
- Start the app without `--log-level=debug`
- Remove `PT_LOG_LEVEL` from `%APPDATA%\PrivateTranscribe\.env`
