# Windows Troubleshooting

## Quick Fixes

### No Window Appears

**Symptoms:** Privoca runs in Task Manager but no window shows

**Solutions:**
1. Check system tray (click ^ caret) for Privoca icon
2. Run with debug: `Privoca.exe --log-level=debug`
3. Try disabling GPU: `Privoca.exe --disable-gpu`

### No Transcriptions

**Symptoms:** Recording works but no text appears

**Solutions:**
1. Check microphone permissions: Settings → Privacy → Microphone
2. Verify mic is selected: Sound settings → Input
3. Test recording in Windows Voice Recorder first

### Active Window Context / UI Automation (UIA) Issues

**Symptoms:**
- Privoca is slow/stutters when typing
- Antivirus/EDR flags PowerShell/UI Automation usage
- You want to disable UI Automation context capture for privacy/policy reasons

**Solutions:**

Option A — Disable *all* active-window context capture (strongest privacy / most compatible):

In `%APPDATA%\Privoca\.env` add:

```ini
# Disable ALL active-window context capture (window title + UIA)
PRIVOCA_DISABLE_CONTEXT_CAPTURE=true
```

Option B — Disable only Windows UIA focused-element text capture:

In `%APPDATA%\Privoca\.env` add:

```ini
# Disable Windows UI Automation (focused element text) capture
PRIVOCA_DISABLE_WINDOWS_UIA=true
```

Restart Privoca after changing `.env`.

### whisper.cpp Not Working

**Symptoms:** Local transcription fails

**Solutions:**
1. whisper.cpp is bundled with the app - try reinstalling
2. If running from source, run `npm run download:whisper-cpp` and confirm `resources\\bin\\whisper-cpp-win32-x64.exe` exists
3. Check antivirus isn't blocking the whisper-cpp executable
4. Clear model cache: delete `%USERPROFILE%\.cache\Privoca\whisper-models`
5. Try cloud mode as fallback

### FFmpeg Issues

**Symptoms:** Transcription fails silently

**Solutions:**
1. Reinstall Privoca (FFmpeg is bundled)
2. Check antivirus isn't quarantining FFmpeg
3. Install system FFmpeg and add to PATH if needed

## Debug Mode

```batch
# Run with debug logging
Privoca.exe --log-level=debug

# Or set in .env file at %APPDATA%\Privoca\.env
Privoca_LOG_LEVEL=debug
```

Logs saved to: `%APPDATA%\Privoca\logs\`

## Common Errors

| Error | Meaning | Fix |
|-------|---------|-----|
| Audio buffer empty | Mic not capturing | Check permissions, try different mic |
| whisper.cpp not found | Binary not accessible | Reinstall app, check antivirus |
| FFmpeg not found | Can't find FFmpeg | Reinstall app, check antivirus |
| Model download failed | Can't download GGML model | Check internet; try cloud mode |

## Windows-Specific Tips

### Windows Defender
Add Privoca to exclusions if blocked:
Settings → Virus & threat protection → Exclusions

### Firewall (Cloud Mode)
Allow Privoca through firewall for cloud transcription

### Permission Errors
Right-click → Run as administrator (or set in Properties → Compatibility)

## Complete Reset

**Recommended path:**
1. Uninstall Privoca from **Settings -> Apps**
2. Run the full cleanup helper:

```batch
npm run uninstall:full:windows
```

That removes Privoca data, caches, logs, and legacy DictateVoice leftovers.

**Manual fallback:**

```batch
rd /s /q "%APPDATA%\Privoca"
rd /s /q "%LOCALAPPDATA%\Privoca"
rd /s /q "%USERPROFILE%\.cache\Privoca"
```

Then reinstall.

## Getting Help

Report issues at https://github.com/Privoca/Privoca/issues with:
- Windows version (`winver`)
- Privoca version
- Debug log contents
- Steps to reproduce
