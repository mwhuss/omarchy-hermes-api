#!/usr/bin/env bash
set -e

PLUGIN_ID="com.mwhuss.omarchy-hermes-api"
TARGET_DIR="$HOME/.config/omarchy/plugins/$PLUGIN_ID"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "==> Setting up Omarchy Hermes Menu Bar Plugin"
echo "Source: $SRC_DIR"
echo "Target: $TARGET_DIR"

# Ensure Node.js 18+ is available
if ! command -v node >/dev/null 2>&1; then
  echo "Error: Node.js (>=18.0.0) is required but not found in PATH." >&2
  exit 1
fi

NODE_MAJOR=$(node -v 2>/dev/null | sed -E 's/^v([0-9]+).*/\1/')
if [ -n "$NODE_MAJOR" ] && [ "$NODE_MAJOR" -lt 18 ]; then
  echo "Error: Node.js version 18 or higher is required (found $(node -v))." >&2
  exit 1
fi

mkdir -p "$HOME/.config/omarchy/plugins"

# Remove existing target if it's a symlink or directory
if [ -L "$TARGET_DIR" ]; then
  echo "==> Unlinking existing plugin link at $TARGET_DIR"
  rm -f "$TARGET_DIR"
elif [ -d "$TARGET_DIR" ]; then
  echo "==> Removing existing plugin directory at $TARGET_DIR"
  rm -rf "$TARGET_DIR"
fi

echo "==> Symlinking plugin into Omarchy plugins directory..."
ln -s "$SRC_DIR" "$TARGET_DIR"

echo "==> Ensuring bridge script is executable..."
chmod +x "$SRC_DIR/bin/hermes-bridge.js"

echo "==> Plugin installation complete!"
echo "You can now add '$PLUGIN_ID' to your bar widgets in ~/.config/omarchy/shell.json or restart Omarchy shell."
