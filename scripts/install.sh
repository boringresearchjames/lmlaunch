#!/usr/bin/env bash
# install.sh — LlamaFleet one-line installer for Ubuntu (systemd).
#
# Usage:
#   curl -fsSL https://github.com/boringresearchjames/llamafleet/releases/latest/download/install.sh | sudo bash
#
# What this does:
#   1. Downloads the latest LlamaFleet release tarball to /opt/llamafleet
#   2. Runs install-ubuntu-systemd.sh (creates service user, systemd unit, env file)
#   3. Runs install-llama-server.sh (detects GPU, downloads matching llama-server binary)

set -euo pipefail

if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
  echo ""
  echo "  LlamaFleet installer must run as root."
  echo "  Run with sudo:"
  echo ""
  echo "    curl -fsSL https://github.com/boringresearchjames/llamafleet/releases/latest/download/install.sh | sudo bash"
  echo ""
  exit 1
fi

GITHUB_REPO="boringresearchjames/llamafleet"
INSTALL_DIR="${LLAMAFLEET_INSTALL_DIR:-/opt/llamafleet}"

log()  { printf '\033[1;34m[LlamaFleet]\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m[LlamaFleet]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[LlamaFleet]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[LlamaFleet]\033[0m ERROR: %s\n' "$*" >&2; exit 1; }

# ── check dependencies ───────────────────────────────────────────────────────

for cmd in curl tar node; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    case "$cmd" in
      curl) apt-get install -y -qq curl ;;
      tar)  apt-get install -y -qq tar ;;
      node)
        die "Node.js (>=18) is required but not installed.
  Install it first:
    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
    sudo apt-get install -y nodejs"
        ;;
    esac
  fi
done

# ── fetch latest release tag ─────────────────────────────────────────────────

log "Fetching latest LlamaFleet release ..."
TAG=$(curl -fsSL --connect-timeout 15 \
  "https://api.github.com/repos/${GITHUB_REPO}/releases/latest" \
  2>/dev/null \
  | grep '"tag_name"' | head -1 \
  | sed 's/.*"tag_name": *"\([^"]*\)".*/\1/' || true)
[[ -z "$TAG" ]] && die "Could not fetch latest release tag from GitHub. Check your internet connection."

VERSION="${TAG#v}"
TARBALL="llamafleet-v${VERSION}.tar.gz"
TARBALL_URL="https://github.com/${GITHUB_REPO}/releases/download/${TAG}/${TARBALL}"
SHA256_URL="${TARBALL_URL}.sha256"

log "Installing LlamaFleet ${TAG} to ${INSTALL_DIR} ..."

# ── download ─────────────────────────────────────────────────────────────────

TMPDIR_WORK=$(mktemp -d)
trap 'rm -rf "$TMPDIR_WORK"' EXIT

log "Downloading $TARBALL ..."
curl -fsSL --connect-timeout 30 -L "$TARBALL_URL" -o "$TMPDIR_WORK/$TARBALL" \
  || die "Download failed: $TARBALL_URL"

# Verify checksum when available
if curl -fsSL --connect-timeout 10 "$SHA256_URL" -o "$TMPDIR_WORK/$TARBALL.sha256" 2>/dev/null; then
  log "Verifying checksum ..."
  (cd "$TMPDIR_WORK" && sha256sum -c "$TARBALL.sha256") \
    || die "Checksum verification failed — the download may be corrupt. Try again."
  ok "Checksum verified."
fi

# ── extract to install dir ────────────────────────────────────────────────────

log "Extracting to ${INSTALL_DIR} ..."
mkdir -p "$INSTALL_DIR"
tar -xzf "$TMPDIR_WORK/$TARBALL" -C "$TMPDIR_WORK"

# Tarball unpacks to llamafleet-vX.Y.Z/ — copy contents into INSTALL_DIR
cp -a "$TMPDIR_WORK/llamafleet-v${VERSION}/." "$INSTALL_DIR/"

# ── run system installer ──────────────────────────────────────────────────────

export LLAMAFLEET_INSTALL_ROOT="$INSTALL_DIR"
bash "$INSTALL_DIR/scripts/install-ubuntu-systemd.sh"

# ── done ─────────────────────────────────────────────────────────────────────

ok ""
ok "LlamaFleet ${TAG} installed."
ok "  Service status : sudo systemctl status llamafleet"
ok "  Dashboard      : http://localhost:8081"
ok "  Env file       : /etc/llamafleet/llamafleet.env"
ok ""
ok "Before starting, edit the env file to set your tokens:"
ok "  sudo nano /etc/llamafleet/llamafleet.env"
ok "    API_AUTH_TOKEN=<your-secret>"
ok "    BRIDGE_AUTH_TOKEN=<your-secret>"
ok ""
ok "Then restart the service:"
ok "  sudo systemctl restart llamafleet"
