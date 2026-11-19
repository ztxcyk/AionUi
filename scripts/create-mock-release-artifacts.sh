#!/usr/bin/env bash

set -euo pipefail

ARTIFACTS_DIR="${1:-build-artifacts}"

rm -rf "$ARTIFACTS_DIR"
mkdir -p "$ARTIFACTS_DIR/windows-build-x64"
mkdir -p "$ARTIFACTS_DIR/windows-build-arm64"
mkdir -p "$ARTIFACTS_DIR/macos-build-x64"
mkdir -p "$ARTIFACTS_DIR/macos-build-arm64"
mkdir -p "$ARTIFACTS_DIR/linux-build-x64"
mkdir -p "$ARTIFACTS_DIR/linux-build-arm64"

# Windows x64
printf 'mock x64 installer\n' > "$ARTIFACTS_DIR/windows-build-x64/AionUi-1.0.0-win-x64.exe"
X64_SHA512=$(node -e "const f=process.argv[1]; process.stdout.write(require('node:crypto').createHash('sha512').update(require('node:fs').readFileSync(f)).digest('base64'))" "$ARTIFACTS_DIR/windows-build-x64/AionUi-1.0.0-win-x64.exe")
X64_SIZE=$(node -p "require('node:fs').statSync(process.argv[1]).size" "$ARTIFACTS_DIR/windows-build-x64/AionUi-1.0.0-win-x64.exe")
cat > "$ARTIFACTS_DIR/windows-build-x64/latest.yml" <<EOF
version: 1.0.0
files:
  - url: AionUi-1.0.0-win-x64.exe
    sha512: ${X64_SHA512}
    size: ${X64_SIZE}
path: AionUi-1.0.0-win-x64.exe
sha512: ${X64_SHA512}
releaseDate: '2025-01-01'
EOF

# Windows arm64
printf 'mock arm64 installer\n' > "$ARTIFACTS_DIR/windows-build-arm64/AionUi-1.0.0-win-arm64.exe"
ARM64_SHA512=$(node -e "const f=process.argv[1]; process.stdout.write(require('node:crypto').createHash('sha512').update(require('node:fs').readFileSync(f)).digest('base64'))" "$ARTIFACTS_DIR/windows-build-arm64/AionUi-1.0.0-win-arm64.exe")
ARM64_SIZE=$(node -p "require('node:fs').statSync(process.argv[1]).size" "$ARTIFACTS_DIR/windows-build-arm64/AionUi-1.0.0-win-arm64.exe")
cat > "$ARTIFACTS_DIR/windows-build-arm64/latest.yml" <<EOF
version: 1.0.0
files:
  - url: AionUi-1.0.0-win-arm64.exe
    sha512: ${ARM64_SHA512}
    size: ${ARM64_SIZE}
path: AionUi-1.0.0-win-arm64.exe
sha512: ${ARM64_SHA512}
releaseDate: '2025-01-01'
EOF

# macOS x64
touch "$ARTIFACTS_DIR/macos-build-x64/AionUi-1.0.0-mac-x64.dmg"
touch "$ARTIFACTS_DIR/macos-build-x64/AionUi-1.0.0-mac-x64.zip"
cat > "$ARTIFACTS_DIR/macos-build-x64/latest-mac.yml" <<'EOF'
version: 1.0.0
files:
  - url: AionUi-1.0.0-mac-x64.dmg
    sha512: fake-sha512-mac-x64
    size: 200000
EOF

# macOS arm64
touch "$ARTIFACTS_DIR/macos-build-arm64/AionUi-1.0.0-mac-arm64.dmg"
touch "$ARTIFACTS_DIR/macos-build-arm64/AionUi-1.0.0-mac-arm64.zip"
cat > "$ARTIFACTS_DIR/macos-build-arm64/latest-mac.yml" <<'EOF'
version: 1.0.0
files:
  - url: AionUi-1.0.0-mac-arm64.dmg
    sha512: fake-sha512-mac-arm64
    size: 200000
EOF

# Linux x64
touch "$ARTIFACTS_DIR/linux-build-x64/AionUi-1.0.0.deb"
cat > "$ARTIFACTS_DIR/linux-build-x64/latest-linux.yml" <<'EOF'
version: 1.0.0
files:
  - url: AionUi-1.0.0.deb
    sha512: fake-sha512-linux
    size: 300000
EOF

# Linux arm64
touch "$ARTIFACTS_DIR/linux-build-arm64/AionUi-1.0.0-arm64.deb"
cat > "$ARTIFACTS_DIR/linux-build-arm64/latest-linux-arm64.yml" <<'EOF'
version: 1.0.0
files:
  - url: AionUi-1.0.0-arm64.deb
    sha512: fake-sha512-linux-arm64
    size: 300000
EOF

# Web-CLI tarballs (5 platforms)
WEB_PLATFORMS=(
  "darwin-arm64"
  "darwin-x86_64"
  "linux-arm64"
  "linux-x86_64"
  "win-x86_64"
)

for plat in "${WEB_PLATFORMS[@]}"; do
  dir="$ARTIFACTS_DIR/web-cli-${plat}"
  mkdir -p "$dir"
  tarball="aionui-web-1.0.0-${plat}.tar.gz"
  touch "$dir/$tarball"
  # Produce a deterministic fake SHA256 file in the expected format:
  # "<64 hex chars>  <filename>"
  echo "0000000000000000000000000000000000000000000000000000000000000000  ${tarball}" > "$dir/${tarball}.sha256"
done

# install-web.sh (version-substituted placeholder)
mkdir -p "$ARTIFACTS_DIR/install-web-script"
cat > "$ARTIFACTS_DIR/install-web-script/install-web.sh" <<'EOF'
#!/usr/bin/env bash
# Mock install-web.sh for release-script-test
set -euo pipefail
echo "mock install-web.sh"
EOF
chmod +x "$ARTIFACTS_DIR/install-web-script/install-web.sh"

echo "Mock artifacts created in $ARTIFACTS_DIR:"
find "$ARTIFACTS_DIR" -type f | sort
