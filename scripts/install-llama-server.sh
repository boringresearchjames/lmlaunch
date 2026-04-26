#!/usr/bin/env bash
# install-llama-server.sh — detect GPU backend and install a matching llama-server binary.
#
# Supports: NVIDIA (CUDA 11/12), AMD (ROCm 5+), Vulkan fallback, CPU (AVX2/AVX).
# Called automatically by install-ubuntu-systemd.sh and by the standalone install.sh.
#
# Environment overrides:
#   LLAMA_SERVER_INSTALL_DIR   — installation target (default: /usr/local/bin)
#   LLAMAFLEET_ENV_FILE        — path to the llamafleet env file (default: /etc/llamafleet/llamafleet.env)
#   LLAMA_CPP_TAG              — pin to a specific llama.cpp release tag (default: latest)
#   SKIP_LLAMA_INSTALL         — set to 1 to skip the entire script

set -euo pipefail

[[ "${SKIP_LLAMA_INSTALL:-0}" == "1" ]] && exit 0

INSTALL_DIR="${LLAMA_SERVER_INSTALL_DIR:-/usr/local/bin}"
LLAMAFLEET_ENV="${LLAMAFLEET_ENV_FILE:-/etc/llamafleet/llamafleet.env}"
LLAMA_CPP_REPO="ggerganov/llama.cpp"
FALLBACK_TAG="b5180"  # minimum known-good tag if GitHub API is unreachable

# ── helpers ───────────────────────────────────────────────────────────────────

log()  { printf '\033[1;34m[llama-server]\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m[llama-server]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[llama-server]\033[0m WARNING: %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[llama-server]\033[0m ERROR: %s\n' "$*" >&2; exit 1; }

# Write or update a key=value pair in the llamafleet env file.
write_env_var() {
  local key="$1" val="$2"
  [[ ! -f "$LLAMAFLEET_ENV" ]] && return
  if grep -q "^${key}=" "$LLAMAFLEET_ENV" 2>/dev/null; then
    sed -i "s|^${key}=.*|${key}=${val}|" "$LLAMAFLEET_ENV"
  elif grep -q "^#${key}=" "$LLAMAFLEET_ENV" 2>/dev/null; then
    sed -i "s|^#${key}=.*|${key}=${val}|" "$LLAMAFLEET_ENV"
  else
    echo "${key}=${val}" >> "$LLAMAFLEET_ENV"
  fi
  log "Set ${key}=${val} in $LLAMAFLEET_ENV"
}

# ── skip if already installed ─────────────────────────────────────────────────

if command -v llama-server >/dev/null 2>&1; then
  existing="$(command -v llama-server)"
  ok "llama-server already installed at $existing — skipping."
  write_env_var "LLAMA_SERVER_BIN" "$existing"
  exit 0
fi

if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
  die "Run as root (use sudo) to install llama-server."
fi

# Ensure required tools are available.
for cmd in curl unzip; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    log "Installing $cmd ..."
    apt-get install -y -qq "$cmd"
  fi
done

# ── fetch release tag + asset list ───────────────────────────────────────────

fetch_latest_tag() {
  local tag=""
  tag=$(curl -fsSL --connect-timeout 10 \
    "https://api.github.com/repos/${LLAMA_CPP_REPO}/releases/latest" \
    2>/dev/null \
    | grep '"tag_name"' | head -1 \
    | sed 's/.*"tag_name": *"\([^"]*\)".*/\1/' || true)
  if [[ -z "$tag" ]]; then
    warn "Could not fetch latest llama.cpp tag from GitHub API; using fallback $FALLBACK_TAG."
    tag="$FALLBACK_TAG"
  fi
  echo "$tag"
}

TAG="${LLAMA_CPP_TAG:-$(fetch_latest_tag)}"
log "Using llama.cpp release: $TAG"

ASSETS=$(curl -fsSL --connect-timeout 15 \
  "https://api.github.com/repos/${LLAMA_CPP_REPO}/releases/tags/${TAG}" \
  2>/dev/null \
  | grep '"name"' \
  | sed 's/.*"name": *"\([^"]*\)".*/\1/' || true)

if [[ -z "$ASSETS" ]]; then
  die "Could not fetch asset list for llama.cpp $TAG. Check your internet connection."
fi

# Return the first Ubuntu x64 asset matching a keyword (empty string if not found).
pick_asset() {
  local hint="$1"
  echo "$ASSETS" \
    | grep -i "ubuntu" \
    | grep -i "x64" \
    | grep -i "$hint" \
    | grep '\.zip$' \
    | head -1 \
    || true
}

# ── GPU detection ─────────────────────────────────────────────────────────────

BACKEND=""

detect_nvidia() {
  command -v nvidia-smi >/dev/null 2>&1 || return 1
  local driver
  driver=$(nvidia-smi --query-gpu=driver_version --format=csv,noheader 2>/dev/null \
    | head -1 | cut -d. -f1 || true)
  [[ -z "$driver" ]] && return 1
  log "Detected NVIDIA GPU — driver version: $driver"
  if (( driver >= 525 )); then
    BACKEND="cuda-cu12"
  elif (( driver >= 450 )); then
    BACKEND="cuda-cu11"
  else
    warn "NVIDIA driver $driver is below 450 (CUDA 11 minimum); falling back to Vulkan."
    BACKEND="vulkan"
  fi
  return 0
}

detect_rocm() {
  if ! command -v rocm-smi >/dev/null 2>&1 && [[ ! -d /opt/rocm ]]; then
    return 1
  fi

  local rocm_ver=""
  if command -v rocm-smi >/dev/null 2>&1; then
    rocm_ver=$(rocm-smi --version 2>/dev/null | grep -oP '\d+\.\d+' | head -1 || true)
  fi
  if [[ -z "$rocm_ver" && -f /opt/rocm/.info/version ]]; then
    rocm_ver=$(grep -oP '\d+\.\d+' /opt/rocm/.info/version 2>/dev/null | head -1 || true)
  fi

  if [[ -z "$rocm_ver" ]]; then
    warn "ROCm detected but version could not be determined; falling back to Vulkan."
    BACKEND="vulkan"
    return 0
  fi

  local major
  major=$(echo "$rocm_ver" | cut -d. -f1)
  if (( major < 5 )); then
    warn "ROCm $rocm_ver is below 5.0; falling back to Vulkan."
    BACKEND="vulkan"
    return 0
  fi

  log "Detected AMD/ROCm $rocm_ver"
  BACKEND="rocm"

  # Detect GFX arch for consumer AMD cards that need HSA_OVERRIDE_GFX_VERSION.
  local gfx=""
  if command -v rocminfo >/dev/null 2>&1; then
    gfx=$(rocminfo 2>/dev/null | grep -oP 'gfx\d+[a-z]*' | head -1 || true)
  fi
  if [[ -n "$gfx" ]]; then
    log "Detected AMD GFX arch: $gfx"
    case "$gfx" in
      gfx1030|gfx1031) write_env_var "HSA_OVERRIDE_GFX_VERSION" "10.3.0" ;;
      gfx1100)         write_env_var "HSA_OVERRIDE_GFX_VERSION" "11.0.0" ;;
      gfx1101)         write_env_var "HSA_OVERRIDE_GFX_VERSION" "11.0.1" ;;
      gfx1102)         write_env_var "HSA_OVERRIDE_GFX_VERSION" "11.0.2" ;;
    esac
  fi
  return 0
}

detect_vulkan() {
  if command -v vulkaninfo >/dev/null 2>&1 \
    || command -v vkcube >/dev/null 2>&1 \
    || dpkg -l libvulkan1 >/dev/null 2>&1; then
    log "Vulkan runtime detected."
    BACKEND="vulkan"
    return 0
  fi
  # GPU present but no Vulkan runtime installed — still use Vulkan build and let the user sort the runtime.
  if command -v lspci >/dev/null 2>&1 && lspci 2>/dev/null | grep -qiE 'VGA|3D|Display'; then
    warn "GPU detected but Vulkan runtime not found. Using Vulkan build."
    warn "To install Vulkan: sudo apt install libvulkan1 vulkan-tools"
    BACKEND="vulkan"
    return 0
  fi
  return 1
}

log "Detecting GPU backend ..."
if detect_nvidia; then
  :
elif detect_rocm; then
  :
elif detect_vulkan; then
  :
else
  if grep -qm1 avx2 /proc/cpuinfo 2>/dev/null; then
    warn "No GPU detected — using CPU (AVX2) build."
    BACKEND="cpu-avx2"
  else
    warn "No GPU detected and AVX2 not available — using basic CPU build."
    BACKEND="cpu"
  fi
fi

log "Selected backend: $BACKEND"

# ── pick asset ────────────────────────────────────────────────────────────────

ASSET=""
case "$BACKEND" in
  cuda-cu12)
    ASSET=$(pick_asset "cuda-cu12")
    if [[ -z "$ASSET" ]]; then ASSET=$(pick_asset "cuda"); fi
    if [[ -z "$ASSET" ]]; then
      warn "No CUDA build found in $TAG assets; falling back to Vulkan."
      ASSET=$(pick_asset "vulkan")
    fi
    ;;
  cuda-cu11)
    ASSET=$(pick_asset "cuda-cu11")
    if [[ -z "$ASSET" ]]; then ASSET=$(pick_asset "cuda"); fi
    if [[ -z "$ASSET" ]]; then
      warn "No CUDA 11 build found in $TAG assets; falling back to Vulkan."
      ASSET=$(pick_asset "vulkan")
    fi
    ;;
  rocm)
    ASSET=$(pick_asset "rocm")
    if [[ -z "$ASSET" ]]; then
      warn "No ROCm build found in $TAG assets; falling back to Vulkan."
      ASSET=$(pick_asset "vulkan")
    fi
    ;;
  vulkan)
    ASSET=$(pick_asset "vulkan")
    ;;
  cpu-avx2)
    ASSET=$(pick_asset "avx2")
    if [[ -z "$ASSET" ]]; then ASSET=$(pick_asset "avx"); fi
    ;;
  cpu)
    ASSET=$(pick_asset "avx")
    if [[ -z "$ASSET" ]]; then
      # Broadest match: Ubuntu x64, no GPU keyword
      ASSET=$(echo "$ASSETS" \
        | grep -i "ubuntu" | grep -i "x64" | grep '\.zip$' \
        | grep -viE 'cuda|rocm|vulkan|metal' | head -1 || true)
    fi
    ;;
esac

if [[ -z "$ASSET" ]]; then
  die "Could not find a suitable llama.cpp binary for backend '$BACKEND' in release $TAG." \
      "Check available assets at: https://github.com/ggerganov/llama.cpp/releases/tag/$TAG"
fi

log "Selected asset: $ASSET"

# ── download + extract + install ─────────────────────────────────────────────

TMPDIR_WORK=$(mktemp -d)
trap 'rm -rf "$TMPDIR_WORK"' EXIT

URL="https://github.com/${LLAMA_CPP_REPO}/releases/download/${TAG}/${ASSET}"
log "Downloading from: $URL"
curl -fsSL --connect-timeout 30 -L "$URL" -o "$TMPDIR_WORK/$ASSET" \
  || die "Download failed. Check your internet connection and try again."

log "Extracting ..."
unzip -q "$TMPDIR_WORK/$ASSET" -d "$TMPDIR_WORK/extracted" \
  || die "Extraction failed — archive may be corrupt."

# Find the binary — recent llama.cpp releases use 'llama-server'; older use 'server'.
BIN=""
BIN=$(find "$TMPDIR_WORK/extracted" -name "llama-server" -type f | head -1 || true)
if [[ -z "$BIN" ]]; then
  BIN=$(find "$TMPDIR_WORK/extracted" -name "server" -type f | head -1 || true)
fi
[[ -z "$BIN" ]] && die "Could not find llama-server binary inside $ASSET."

install -m 0755 "$BIN" "$INSTALL_DIR/llama-server"

# ── verify + record ──────────────────────────────────────────────────────────

VERSION_OUT=$("$INSTALL_DIR/llama-server" --version 2>&1 | head -1 || true)
ok "llama-server installed at $INSTALL_DIR/llama-server"
[[ -n "$VERSION_OUT" ]] && ok "Version: $VERSION_OUT"

write_env_var "LLAMA_SERVER_BIN" "$INSTALL_DIR/llama-server"
