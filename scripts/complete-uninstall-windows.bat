@echo off
setlocal EnableExtensions

echo WARNING: This performs a full Privoca cleanup on Windows.
echo Use Windows uninstall first if Privoca was installed normally.
choice /M "Continue with full cleanup"
if errorlevel 2 goto :eof

echo Stopping running Privoca / legacy DictateVoice processes...
taskkill /F /IM Privoca.exe >nul 2>&1
taskkill /F /IM DictateVoice.exe >nul 2>&1
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-Process | Where-Object { $_.ProcessName -match 'Privoca|DictateVoice|dictate-voice' } | Stop-Process -Force" >nul 2>&1

echo Removing app data and caches...
if exist "%APPDATA%\Privoca" rd /s /q "%APPDATA%\Privoca"
if exist "%LOCALAPPDATA%\Privoca" rd /s /q "%LOCALAPPDATA%\Privoca"
if exist "%APPDATA%\dictate-voice" rd /s /q "%APPDATA%\dictate-voice"
if exist "%LOCALAPPDATA%\dictate-voice" rd /s /q "%LOCALAPPDATA%\dictate-voice"
if exist "%USERPROFILE%\.cache\Privoca" rd /s /q "%USERPROFILE%\.cache\Privoca"
if exist "%USERPROFILE%\.cache\dictatevoice" rd /s /q "%USERPROFILE%\.cache\dictatevoice"
if exist "%USERPROFILE%\.cache\whisper" rd /s /q "%USERPROFILE%\.cache\whisper"

set PROJECT_ENV=%~dp0..\.env
choice /M "Remove local project .env file if present"
if errorlevel 2 goto done_env
if exist "%PROJECT_ENV%" del /f /q "%PROJECT_ENV%"
:done_env

echo.
echo Full Windows cleanup complete.
echo If Privoca is still installed, remove it from Settings ^> Apps first or now.
endlocal
