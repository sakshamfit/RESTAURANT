#!/usr/bin/env bash
# NEXORAOSP RESTAURANT — portable desktop app installer.
# Installs the app to ~/.local/share/nexoraosp-restaurant and registers a
# desktop entry, without needing root. Run:  ./install.sh
set -euo pipefail

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST_DIR="${HOME}/.local/share/nexoraosp-restaurant"

echo "Installing NEXORAOSP RESTAURANT to ${DEST_DIR} ..."
mkdir -p "${DEST_DIR}"
cp -R "${SRC_DIR}/resources" "${SRC_DIR}/launcher.cjs" "${DEST_DIR}/"
install -m 0755 "${SRC_DIR}/nexoraosp-restaurant" "${DEST_DIR}/nexoraosp-restaurant"

# Desktop entry (Exec must point at the real location)
mkdir -p "${HOME}/.local/share/applications" "${HOME}/.local/share/icons/hicolor/512x512/apps"
sed "s|/opt/nexoraosp-restaurant/nexoraosp-restaurant|${DEST_DIR}/nexoraosp-restaurant|" \
  "${SRC_DIR}/nexoraosp-restaurant.desktop" > "${HOME}/.local/share/applications/nexoraosp-restaurant.desktop"
install -m 0644 "${SRC_DIR}/resources/icon.png" "${HOME}/.local/share/icons/hicolor/512x512/apps/nexoraosp-restaurant.png"

# Create a convenient launcher on the PATH
mkdir -p "${HOME}/.local/bin"
ln -sf "${DEST_DIR}/nexoraosp-restaurant" "${HOME}/.local/bin/nexoraosp-restaurant"

echo
echo "Done! Start it from your app menu ('NEXORAOSP RESTAURANT') or run:"
echo "  ~/.local/bin/nexoraosp-restaurant"
