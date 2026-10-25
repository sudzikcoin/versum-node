#!/bin/sh
# Builds "Versum Node Installer.app" and a .dmg around it, for ONE architecture (macOS runner).
#   build-app.sh <version> <arch: arm64|x86_64> <outdir> <versum-node binary> <python tree dir>
# Resources/app holds: versum-node (the single binary), python/ (python-build-standalone), probe/,
# installer/install-macos.sh, version.txt, arch.txt. The app's executable is packaging/macos/launcher.sh.
# Ad-hoc signed; NOT notarized — the page documents right-click → Open.
set -eu
VERSION="${1:?version}"; ARCH="${2:?arch}"; OUT="${3:?outdir}"; BIN="${4:?versum-node binary}"; PY="${5:?python dir}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
case "$ARCH" in arm64) SUFFIX=arm64 ;; x86_64) SUFFIX=x64 ;; *) echo "arch must be arm64 or x86_64" >&2; exit 2 ;; esac
STAGE="$OUT/dmg-$SUFFIX"; APP="$STAGE/Versum Node Installer.app"
rm -rf "$STAGE"; mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/app/installer"
cp "$BIN" "$APP/Contents/Resources/app/versum-node"; chmod 755 "$APP/Contents/Resources/app/versum-node"
cp -R "$PY" "$APP/Contents/Resources/app/python"
cp -R "$ROOT/probe" "$APP/Contents/Resources/app/probe"
cp "$ROOT/installer/install-macos.sh" "$APP/Contents/Resources/app/installer/"; chmod 755 "$APP/Contents/Resources/app/installer/install-macos.sh"
cp "$ROOT/README.md" "$ROOT/LICENSE" "$APP/Contents/Resources/app/"
printf '%s\n' "$VERSION" > "$APP/Contents/Resources/app/version.txt"
printf '%s\n' "$ARCH" > "$APP/Contents/Resources/app/arch.txt"
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
  <key>LSArchitecturePriority</key><array><string>$ARCH</string></array>
  <key>NSHumanReadableCopyright</key><string>Apache-2.0 — github.com/sudzikcoin/versum-node</string>
</dict></plist>
PL
cat > "$STAGE/READ ME — unsigned.txt" <<TXT
Versum node $VERSION ($ARCH) — this installer is not signed by Apple yet.
Open it with: right-click (or Control-click) "Versum Node Installer" → Open → Open.
On macOS 15 (Sequoia) a first double-click shows "not opened"; then go to
System Settings → Privacy & Security → scroll down → "Open Anyway", and open it again.
It installs under ~/.versum-node only (one binary + an embedded Python; no Docker, no admin
password), registers a launchd agent, and opens the node page http://127.0.0.1:3311/ when done.
Jobs run under macOS's own sandbox (sandbox-exec): no network, no access to your files.
Remove: ~/.versum-node/app/uninstall.sh      Source: https://github.com/sudzikcoin/versum-node
TXT
codesign --force --deep --sign - "$APP"
hdiutil create -volname "Versum Node" -srcfolder "$STAGE" -ov -format UDZO "$OUT/Versum-Node-$SUFFIX.dmg"
ls -la "$OUT/Versum-Node-$SUFFIX.dmg"
