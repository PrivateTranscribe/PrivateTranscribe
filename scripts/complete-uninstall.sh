#!/usr/bin/env bash

# macOS full uninstall helper.
# On Linux, run scripts/complete-uninstall-linux.sh instead (npm run uninstall:full:linux).

set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This script is for macOS only."
  echo "On Linux, run: bash scripts/complete-uninstall-linux.sh"
  exit 1
fi

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "⚠️  This script will stop Privoca, remove the installed app, and delete caches, databases, and preferences."
read -r -p "Continue with the full uninstall? [y/N]: " confirm
if [[ ! "$confirm" =~ ^[Yy]$ ]]; then
  echo "Aborted."
  exit 0
fi

remove_target() {
  local target="$1"
  if [[ -e "$target" ]]; then
    echo "Removing $target"
    rm -rf "$target"
  fi
}

# Use sudo only for /Applications bundles where ownership may be root.
remove_app_bundle() {
  local target="$1"
  if [[ -e "$target" ]]; then
    echo "Removing $target (may require admin password)..."
    sudo rm -rf "$target"
  fi
}

echo "Stopping running Privoca / legacy DictateVoice processes..."
pkill -f "Privoca" 2>/dev/null || true
pkill -f "DictateVoice" 2>/dev/null || true
pkill -f "dictate-voice" 2>/dev/null || true
pkill -f "Electron Helper.*Privoca" 2>/dev/null || true
pkill -f "Electron Helper.*DictateVoice" 2>/dev/null || true

echo "Removing /Applications/Privoca.app and legacy DictateVoice.app (requires admin)..."
remove_app_bundle "/Applications/Privoca.app"
remove_app_bundle "/Applications/DictateVoice.app"

echo "Purging Application Support data..."
remove_target "$HOME/Library/Application Support/Privoca"
remove_target "$HOME/Library/Application Support/Privoca-dev"
remove_target "$HOME/Library/Application Support/com.Privoca.app"
remove_target "$HOME/Library/Application Support/com.Privoca.app.Privoca"
remove_target "$HOME/Library/Application Support/DictateVoice"
remove_target "$HOME/Library/Application Support/dictate-voice"
remove_target "$HOME/Library/Application Support/DictateVoice-dev"
remove_target "$HOME/Library/Application Support/com.dictatevoice"
remove_target "$HOME/Library/Application Support/com.dictatevoice.DictateVoice"

echo "Removing caches, logs, and saved state..."
remove_target "$HOME/Library/Caches/Privoca"
remove_target "$HOME/Library/Caches/com.Privoca.app.Privoca"
remove_target "$HOME/Library/Caches/dictate-voice"
remove_target "$HOME/Library/Caches/com.dictatevoice.DictateVoice"
remove_target "$HOME/Library/Preferences/com.Privoca.app.Privoca.plist"
remove_target "$HOME/Library/Preferences/com.Privoca.app.helper.plist"
remove_target "$HOME/Library/Preferences/com.dictatevoice.DictateVoice.plist"
remove_target "$HOME/Library/Preferences/com.dictatevoice.helper.plist"
remove_target "$HOME/Library/Logs/Privoca"
remove_target "$HOME/Library/Logs/DictateVoice"
remove_target "$HOME/Library/Saved Application State/com.Privoca.app.Privoca.savedState"
remove_target "$HOME/Library/Saved Application State/com.dictatevoice.DictateVoice.savedState"

echo "Cleaning temporary files..."
shopt -s nullglob
for tmp in /tmp/Privoca* /tmp/dictatevoice*; do
  remove_target "$tmp"
done
for crash in "$HOME/Library/Application Support/CrashReporter"/Privoca_* \
             "$HOME/Library/Application Support/CrashReporter"/DictateVoice_*; do
  remove_target "$crash"
done
shopt -u nullglob

read -r -p "Remove all downloaded model caches (~/.cache/Privoca — Whisper, Parakeet, GGUF)? [y/N]: " wipe_models
if [[ "$wipe_models" =~ ^[Yy]$ ]]; then
  remove_target "$HOME/.cache/Privoca/whisper-models"
  remove_target "$HOME/.cache/Privoca/parakeet-models"
  remove_target "$HOME/.cache/Privoca/models"
  # Legacy model cache paths
  remove_target "$HOME/.cache/whisper"
  remove_target "$HOME/Library/Application Support/whisper"
  remove_target "$HOME/Library/Application Support/Privoca/models"
  remove_target "$HOME/Library/Application Support/DictateVoice/models"
  rmdir "$HOME/.cache/Privoca" 2>/dev/null || true
fi

ENV_FILE="$PROJECT_ROOT/.env"
if [[ -f "$ENV_FILE" ]]; then
  read -r -p "Remove the local environment file at $ENV_FILE? [y/N]: " wipe_env
  if [[ "$wipe_env" =~ ^[Yy]$ ]]; then
    echo "Removing $ENV_FILE"
    rm -f "$ENV_FILE"
  fi
fi

cat <<'EOF'
macOS keeps microphone, screen recording, and accessibility approvals even after files are removed.
Reset them if you want a truly fresh start:
  tccutil reset Microphone com.Privoca.app
  tccutil reset Accessibility com.Privoca.app
  tccutil reset ScreenCapture com.Privoca.app

Legacy DictateVoice resets if needed:
  tccutil reset Microphone com.dictatevoice.app
  tccutil reset Accessibility com.dictatevoice.app
  tccutil reset ScreenCapture com.dictatevoice.app

Full uninstall complete. Reboot if you removed permissions, then reinstall or run npm scripts on a clean tree.
EOF
