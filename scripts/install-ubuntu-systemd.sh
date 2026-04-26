#!/usr/bin/env bash
set -euo pipefail

if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
  echo "Run as root (use sudo)."
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SYSTEMD_SRC="$REPO_ROOT/deploy/systemd"
SYSTEMD_DST="/etc/systemd/system"
ENV_DST="/etc/llamafleet"
DATA_ROOT="/var/lib/llamafleet"
API_URL="${LLAMAFLEET_DESKTOP_URL:-http://localhost:8081}"

# Verify Node.js and npm are available before proceeding.
if ! command -v node >/dev/null 2>&1; then
  echo "node not found in PATH. Install Node.js (>=18) before running this script."
  exit 1
fi
if ! command -v npm >/dev/null 2>&1; then
  echo "npm not found in PATH. Install npm before running this script."
  exit 1
fi

# Install production Node.js dependencies for the app packages.
echo "Installing Node.js dependencies..."
npm --prefix "$REPO_ROOT/apps/api" install --omit=dev --no-bin-links
npm --prefix "$REPO_ROOT/apps/host-bridge" install --omit=dev --no-bin-links
echo "Dependencies installed."

ensure_user() {
  local user="$1"
  local home="$2"
  if ! id -u "$user" >/dev/null 2>&1; then
    useradd -r -m -d "$home" -s /usr/sbin/nologin "$user"
  fi
}

install -d -m 0755 "$ENV_DST"
install -d -m 0755 "$DATA_ROOT"
ensure_user llamafleet "$DATA_ROOT/llamafleet"
install -d -m 0750 -o llamafleet -g llamafleet "$DATA_ROOT/api"
install -d -m 0750 -o llamafleet -g llamafleet "$DATA_ROOT/bridge"

# Make the project directory readable/executable by the llamafleet service user.
chmod -R a+rX "$REPO_ROOT"

# Restore ownership to the invoking user so future redeploys don't need sudo to
# remove root-owned node_modules.
if [[ -n "${SUDO_USER:-}" && "${SUDO_USER}" != "root" ]]; then
  chown -R "${SUDO_USER}:${SUDO_USER}" "$REPO_ROOT"
  chmod -R a+rX "$REPO_ROOT"
fi

# Generate the service file with the actual project path substituted in place of
# the /opt/llamafleet placeholder so the service works regardless of install location.
sed "s|/opt/llamafleet|${REPO_ROOT}|g" \
  "$SYSTEMD_SRC/llamafleet.service" > "$SYSTEMD_DST/llamafleet.service"
chmod 0644 "$SYSTEMD_DST/llamafleet.service"

if [[ ! -f "$ENV_DST/llamafleet.env" ]]; then
  install -m 0640 "$SYSTEMD_SRC/env/llamafleet.env.example" "$ENV_DST/llamafleet.env"
fi

# Auto-detect the models directory from the invoking user's LM Studio setup.
# Resolves symlinks so the llamafleet service user sees a real path it can be
# granted access to via ACL (symlink targets on mounted drives need explicit
# permissions on every path component).
setup_models_dir() {
  local invoking_user="${SUDO_USER:-}"
  if [[ -z "$invoking_user" || "$invoking_user" == "root" ]]; then
    return
  fi

  local user_home
  user_home="$(getent passwd "$invoking_user" | cut -d: -f6)"
  local lmstudio_models="$user_home/.lmstudio/models"

  if [[ ! -e "$lmstudio_models" ]]; then
    return
  fi

  local real_dir
  real_dir="$(realpath "$lmstudio_models" 2>/dev/null || readlink -f "$lmstudio_models")"

  if [[ -z "$real_dir" || ! -d "$real_dir" ]]; then
    return
  fi

  echo "Detected models directory: $real_dir"

  # Grant llamafleet read+execute on the models dir and every parent directory
  # so it can traverse into mounted drives with restricted permissions.
  if command -v setfacl >/dev/null 2>&1; then
    local dir="$real_dir"
    while [[ "$dir" != "/" ]]; do
      setfacl -m u:llamafleet:rx "$dir" 2>/dev/null || true
      dir="$(dirname "$dir")"
    done
    echo "ACL permissions granted for lmlaunch on models path."
  else
    echo "Warning: setfacl not available (install acl package)."
    echo "  Grant read access manually: chmod o+rx <each directory> up to $real_dir"
  fi

  # Write MODELS_DIR into the env file only when a commented placeholder exists
  # (avoids overwriting an existing user-set value on reinstall).
  if [[ -f "$ENV_DST/llamafleet.env" ]]; then
    if grep -q "^MODELS_DIR=" "$ENV_DST/llamafleet.env"; then
      echo "MODELS_DIR already set; skipping auto-detection."
    elif grep -q "^#MODELS_DIR=" "$ENV_DST/llamafleet.env"; then
      sed -i "s|^#MODELS_DIR=.*|MODELS_DIR=$real_dir|" "$ENV_DST/llamafleet.env"
      echo "Set MODELS_DIR=$real_dir in $ENV_DST/llamafleet.env"
    else
      echo "MODELS_DIR=$real_dir" >> "$ENV_DST/llamafleet.env"
      echo "Set MODELS_DIR=$real_dir in $ENV_DST/llamafleet.env"
    fi
  fi
}

setup_models_dir

# Install or detect llama-server binary before the service starts.
bash "$REPO_ROOT/scripts/install-llama-server.sh"

systemctl daemon-reload
systemctl enable --now llamafleet

install_desktop_launcher() {
  local launcher_name="llamafleet.desktop"
  local app_launcher="/usr/share/applications/${launcher_name}"
  local desktop_target=""

  cat > "$app_launcher" <<EOF
[Desktop Entry]
Type=Application
Version=1.0
Name=LlamaFleet
Comment=Open LlamaFleet dashboard
Exec=xdg-open ${API_URL}
Terminal=false
Categories=Development;Utility;
StartupNotify=true
EOF
  chmod 0644 "$app_launcher"

  if [[ -n "${SUDO_USER:-}" && "${SUDO_USER}" != "root" ]]; then
    desktop_target="$(getent passwd "${SUDO_USER}" | cut -d: -f6)/Desktop"
  else
    desktop_target="/root/Desktop"
  fi

  if [[ -d "$desktop_target" ]]; then
    install -m 0755 "$app_launcher" "$desktop_target/$launcher_name"
    if [[ -n "${SUDO_USER:-}" && "${SUDO_USER}" != "root" ]]; then
      chown "${SUDO_USER}:${SUDO_USER}" "$desktop_target/$launcher_name" || true
    fi
    echo "Desktop launcher installed: $desktop_target/$launcher_name"
  else
    echo "Desktop directory not found; launcher added to $app_launcher only."
  fi
}

install_desktop_launcher

printf '\nInstalled llamafleet systemd service.\n'
printf 'Edit env file before starting: %s/llamafleet.env\n' "$ENV_DST"
printf '  - Set API_AUTH_TOKEN and BRIDGE_AUTH_TOKEN\n'
printf '  - Set LLAMA_SERVER_BIN to your llama-server binary path\n'
  printf '  - Set LLAMAFLEET_PUBLIC_HOST to this machine'\''s IP if accessing remotely\n'
printf '  - MODELS_DIR auto-detected from ~/.lmstudio/models (override if needed)\n'
printf 'Then reload: sudo systemctl restart llamafleet\n'
