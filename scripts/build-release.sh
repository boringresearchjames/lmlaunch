#!/usr/bin/env bash
# build-release.sh — pack a versioned LlamaFleet release tarball for GitHub Releases.
#
# Output: dist/llamafleet-vX.Y.Z.tar.gz  (with pre-installed production node_modules)
#         dist/llamafleet-vX.Y.Z.tar.gz.sha256
#
# Usage:
#   bash scripts/build-release.sh
#   bash scripts/build-release.sh --version 0.2.0   # override version

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# ── version ──────────────────────────────────────────────────────────────────

if [[ "${1:-}" == "--version" && -n "${2:-}" ]]; then
  VERSION="$2"
elif [[ -n "${RELEASE_VERSION:-}" ]]; then
  VERSION="$RELEASE_VERSION"
elif command -v node >/dev/null 2>&1; then
  VERSION=$(node -p "require('./package.json').version" 2>/dev/null)
else
  VERSION=$(grep '"version"' package.json | head -1 | sed 's/.*"\([0-9][^"]*\)".*/\1/')
fi

[[ -z "$VERSION" ]] && { echo "Could not determine version from package.json"; exit 1; }
echo "Building LlamaFleet v${VERSION} ..."

# ── paths ─────────────────────────────────────────────────────────────────────

DIST_DIR="$REPO_ROOT/dist"
STAGE_DIR="$DIST_DIR/stage/llamafleet-v${VERSION}"
TARBALL_NAME="llamafleet-v${VERSION}.tar.gz"
TARBALL_PATH="$DIST_DIR/$TARBALL_NAME"

rm -rf "$DIST_DIR"
mkdir -p "$STAGE_DIR"

# ── install production dependencies ──────────────────────────────────────────

for app in api host-bridge bridge-router; do
  echo "  → Installing production deps: apps/$app"
  npm --prefix "$REPO_ROOT/apps/$app" install --omit=dev --no-bin-links --silent
done

# ── copy files into staging dir ──────────────────────────────────────────────

# Node.js apps with their pre-installed node_modules
for app in api host-bridge bridge-router; do
  mkdir -p "$STAGE_DIR/apps/$app"
  cp -r "$REPO_ROOT/apps/$app/src"          "$STAGE_DIR/apps/$app/"
  cp    "$REPO_ROOT/apps/$app/package.json" "$STAGE_DIR/apps/$app/"
  cp -r "$REPO_ROOT/apps/$app/node_modules" "$STAGE_DIR/apps/$app/"
done

# Web app (no node_modules)
mkdir -p "$STAGE_DIR/apps/web"
cp "$REPO_ROOT/apps/web/app.js" \
   "$REPO_ROOT/apps/web/index.html" \
   "$REPO_ROOT/apps/web/styles.css" \
   "$STAGE_DIR/apps/web/"

# Check for optional data directories (e.g. default config files)
for app in api; do
  if [[ -d "$REPO_ROOT/apps/$app/data" ]]; then
    cp -r "$REPO_ROOT/apps/$app/data" "$STAGE_DIR/apps/$app/"
  fi
done

# Deploy configs, scripts, root package
cp -r "$REPO_ROOT/deploy"      "$STAGE_DIR/"
cp -r "$REPO_ROOT/scripts"     "$STAGE_DIR/"
cp    "$REPO_ROOT/package.json" "$STAGE_DIR/"
cp    "$REPO_ROOT/README.md"    "$STAGE_DIR/"
cp    "$REPO_ROOT/LICENSE"      "$STAGE_DIR/"

# ── pack ─────────────────────────────────────────────────────────────────────

echo "  → Creating $TARBALL_NAME ..."
tar -czf "$TARBALL_PATH" \
  -C "$DIST_DIR/stage" \
  "llamafleet-v${VERSION}"

# Cleanup staging
rm -rf "$DIST_DIR/stage"

# ── checksum ─────────────────────────────────────────────────────────────────

SHA256=$(sha256sum "$TARBALL_PATH" | awk '{print $1}')
echo "$SHA256  $TARBALL_NAME" > "${TARBALL_PATH}.sha256"

SIZE=$(du -h "$TARBALL_PATH" | cut -f1)

echo ""
echo "Release artifact : $TARBALL_PATH"
echo "SHA256           : $SHA256"
echo "Size             : $SIZE"
echo ""
echo "To release: git tag v${VERSION} && git push origin v${VERSION}"
