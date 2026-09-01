#!/usr/bin/env bash
set -e

PLUGIN_ID="com.mwhuss.omarchy-hermes-api"
TARGET_DIR="$HOME/.config/omarchy/plugins/$PLUGIN_ID"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "==> Setting up Omarchy Hermes Menu Bar Plugin"
echo "Source: $SRC_DIR"
echo "Target: $TARGET_DIR"

# Ensure dependencies are installed
if [ ! -d "$SRC_DIR/node_modules" ]; then
  echo "==> Installing npm dependencies..."
  (cd "$SRC_DIR" && npm install --production)
fi

mkdir -p "$HOME/.config/omarchy/plugins"

# Remove existing target if it's a symlink or directory
if [ -L "$TARGET_DIR" ] || [ -d "$TARGET_DIR" ]; then
  echo "==> Removing existing plugin link/dir at $TARGET_DIR"
  rm -rf "$TARGET_DIR"
fi

echo "==> Symlinking plugin into Omarchy plugins directory..."
ln -s "$SRC_DIR" "$TARGET_DIR"

echo "==> Ensuring bridge script is executable..."
chmod +x "$SRC_DIR/bin/hermes-bridge.js"

echo "==> Plugin installation complete!"
echo "You can now add '$PLUGIN_ID' to your bar widgets in ~/.config/omarchy/shell.json or restart Omarchy shell."
