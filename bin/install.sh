#!/usr/bin/bash
set -e

PLUGIN_ID="com.mwhuss.omarchy-hermes-api"
TARGET_DIR="$HOME/.config/omarchy/plugins/$PLUGIN_ID"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "==> Setting up Omarchy Hermes Menu Bar Plugin"
echo "Source: $SRC_DIR"
echo "Target: $TARGET_DIR"

# Ensure the Rust toolchain is available and build the bridge binary
if ! command -v cargo >/dev/null 2>&1; then
  echo "Error: the Rust toolchain (cargo) is required to build the bridge binary but was not found." >&2
  exit 1
fi

echo "==> Building Rust bridge (cargo build --release)..."
cargo build --release --manifest-path "$SRC_DIR/Cargo.toml" --target-dir "$SRC_DIR/target"
chmod +x "$SRC_DIR/target/release/hermes-bridge"
ln -sf "$SRC_DIR/target/release/hermes-bridge" "$SRC_DIR/bin/hermes-bridge"

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

echo "==> Ensuring helper scripts are executable..."
chmod +x "$SRC_DIR/bin/hermes-toggle"

echo "==> Plugin installation complete!"
echo "You can now add '$PLUGIN_ID' to your bar widgets in ~/.config/omarchy/shell.json or restart Omarchy shell."
