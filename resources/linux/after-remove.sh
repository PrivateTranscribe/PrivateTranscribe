#!/bin/bash
set -euo pipefail

for CACHE_DIR in "$HOME/.cache/Privoca" "$HOME/.cache/dictatevoice"; do
  MODELS_DIR="$CACHE_DIR/models"

  if [ -d "$MODELS_DIR" ]; then
    rm -rf "$MODELS_DIR"
    echo "Removed cached models from $CACHE_DIR"
  fi

  if [ -d "$CACHE_DIR" ]; then
    rmdir "$CACHE_DIR" 2>/dev/null || true
  fi
done
