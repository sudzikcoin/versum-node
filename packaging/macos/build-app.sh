#!/bin/sh
# Builds "Versum Node Installer.app" and a .dmg around it (macOS runner). Usage: build-app.sh <version> <outdir>
# The app's executable is packaging/macos/launcher.sh; Resources/app is this repository (the same code the
# one-liner installs). Ad-hoc signed; NOT notarized — the page documents right-click → Open.
set -eu
VERSION="${1:?version}"; OUT="${2:?outdir}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
APP="$OUT/dmg/Versum Node Installer.app"
rm -rf "$OUT/dmg"; mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/app"
for d in bin lib egress installer protocol docs; do cp -R "$ROOT/$d" "$APP/Contents/Resources/app/"; done
cp "$ROOT/install.sh" "$ROOT/package.json" "$ROOT/README.md" "$ROOT/LICENSE" "$APP/Contents/Resources/app/"
printf '%s\n' "$VERSION" > "$APP/Contents/Resources/app/version.txt"
cp "$ROOT/packaging/macos/launcher.sh" "$APP/Contents/MacOS/versum-node-installer"; chmod 755 "$APP/Contents/MacOS/versum-node-installer"
cat > "$APP/Contents/Info.plist" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>Versum Node Installer</string>
  <key>CFBundleDisplayName</key><string>Versum Node Installer</string>
  <key>CFBundleIdentifier</key><string>io.suverse.versum-node.installer</string>
  <key>CFBundleVersion</key><string>${VERSION#v}</string>
  <key>CFBundleShortVersionString</key><string>${VERSION#v}</string>
  <key>CFBundleExecutable</key><string>versum-node-installer</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>LSUIElement</key><true/>
  <key>NSHumanReadableCopyright</key><string>Apache-2.0 — github.com/sudzikcoin/versum-node</string>
</dict></plist>
PL
ln -sf /Applications "$OUT/dmg/Applications" 2>/dev/null || true
cat > "$OUT/dmg/READ ME — unsigned.txt" <<TXT
Versum node $VERSION — this installer is not signed by Apple yet.
Open it with: right-click (or Control-click) "Versum Node Installer" → Open → Open.
On macOS 15 (Sequoia) a first double-click shows "not opened"; then go to
System Settings → Privacy & Security → scroll down → "Open Anyway", and open it again.
It installs under ~/.versum-node only, never asks for an administrator password, and opens
the node page http://127.0.0.1:3311/ when done. Source: https://github.com/sudzikcoin/versum-node
TXT
codesign --force --deep --sign - "$APP"
hdiutil create -volname "Versum Node" -srcfolder "$OUT/dmg" -ov -format UDZO "$OUT/Versum-Node.dmg"
ls -la "$OUT/Versum-Node.dmg"
