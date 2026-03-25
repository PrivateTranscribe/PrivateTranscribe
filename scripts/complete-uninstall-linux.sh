#!/usr/bin/env bash

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

remove_target() {
  local target="$1"
  if [[ -e "$target" ]]; then
    echo "Removing $target"
    rm -rf "$target"
  fi
}

command_exists() {
  command -v "$1" >/dev/null 2>&1
}

echo "⚠️  This script performs a full Privoca cleanup on Linux."
echo "It does NOT uninstall a system package for you."
echo "Use your package manager first if Privoca was installed as .deb/.rpm/Flatpak."
read -r -p "Continue with full cleanup? [y/N]: " confirm
if [[ ! "$confirm" =~ ^[Yy]$ ]]; then
  echo "Aborted."
  exit 0
fi

echo "Stopping running Privoca / legacy DictateVoice processes..."
pkill -f "Privoca" 2>/dev/null || true
pkill -f "DictateVoice" 2>/dev/null || true
pkill -f "dictate-voice" 2>/dev/null || true

read -r -p "Was Privoca installed via apt/dpkg? [y/N]: " remove_deb
if [[ "$remove_deb" =~ ^[Yy]$ ]]; then
  if command_exists apt; then
    sudo apt remove -y privoca 2>/dev/null || true
  elif command_exists dpkg; then
    sudo dpkg -r privoca 2>/dev/null || true
  fi
fi

read -r -p "Was Privoca installed via dnf/rpm? [y/N]: " remove_rpm
if [[ "$remove_rpm" =~ ^[Yy]$ ]]; then
  if command_exists dnf; then
    sudo dnf remove -y privoca 2>/dev/null || true
  elif command_exists rpm; then
    sudo rpm -e privoca 2>/dev/null || true
  fi
fi

read -r -p "Was Privoca installed via Flatpak? [y/N]: " remove_flatpak
if [[ "$remove_flatpak" =~ ^[Yy]$ ]] && command_exists flatpak; then
  flatpak uninstall -y com.privoca.app 2>/dev/null || true
  flatpak uninstall -y com.dictatevoice.app 2>/dev/null || true
fi

echo "Removing user data, logs, and legacy DictateVoice paths..."
remove_target "$HOME/.config/Privoca"
remove_target "$HOME/.config/Privoca-dev"
remove_target "$HOME/.config/dictate-voice"
remove_target "$HOME/.config/DictateVoice"
remove_target "$HOME/.local/share/Privoca"
remove_target "$HOME/.local/share/DictateVoice"
remove_target "$HOME/.local/state/Privoca"
remove_target "$HOME/.local/state/DictateVoice"

echo "Cleaning /tmp Privoca/DictateVoice temp files..."
shopt -s nullglob
for tmp in /tmp/Privoca* /tmp/privoca* /tmp/DictateVoice* /tmp/dictatevoice*; do
  remove_target "$tmp"
done
shopt -u nullglob

read -r -p "Remove downloaded model caches (~/.cache/PrivateTranscribe — Whisper, Parakeet, GGUF)? [y/N]: " wipe_models
if [[ "$wipe_models" =~ ^[Yy]$ ]]; then
  remove_target "$HOME/.cache/PrivateTranscribe"
  remove_target "$HOME/.cache/Privoca"
  remove_target "$HOME/.cache/dictatevoice"
  remove_target "$HOME/.cache/whisper"
fi

read -r -p "Remove local project .env file at $PROJECT_ROOT/.env if present? [y/N]: " wipe_env
if [[ "$wipe_env" =~ ^[Yy]$ ]]; then
  rm -f "$PROJECT_ROOT/.env"
fi

cat <<'EOF'
Full Linux cleanup complete.

Recommended reinstall paths:
- .deb/.rpm: reinstall via package manager
- AppImage/tar.gz: download a fresh build and run it directly
- Source checkout: npm install && npm run dev
EOF
