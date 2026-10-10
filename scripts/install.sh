#!/usr/bin/env bash
set -Eeuo pipefail

OWNER="fazilatma"
REPO="test"
BRANCH="${SEPEHR_BRANCH:-arena/b1e2952d-test}"
INSTALL_DIR="${SEPEHR_INSTALL_DIR:-$HOME/sepehr-worker-browser}"
MODE="${1:-deploy}"
PORT="${PORT:-8787}"

usage() {
  cat <<'USAGE'
Sepehr Worker Browser installer

Usage:
  install.sh [deploy|install|dev]

Modes:
  deploy   Download source, install dependencies, log in to Cloudflare if needed,
           and deploy the Worker (default).
  install  Download source and install dependencies only.
  dev      Run Wrangler's local preview server (Linux VPS only; not production).

Environment:
  SEPEHR_INSTALL_DIR  Installation directory (default: ~/sepehr-worker-browser)
  SEPEHR_BRANCH       GitHub branch to download (default: arena/b1e2952d-test)
  PORT                Local preview port (default: 8787)
USAGE
}

if [[ "$MODE" == "-h" || "$MODE" == "--help" ]]; then
  usage
  exit 0
fi
case "$MODE" in
  deploy|install|dev) ;;
  *) usage >&2; exit 2 ;;
esac

is_termux=false
if [[ -n "${TERMUX_VERSION:-}" || "${PREFIX:-}" == *com.termux* ]]; then
  is_termux=true
fi
if [[ "$MODE" == "dev" && "$is_termux" == true ]]; then
  echo "Local Wrangler preview is not supported reliably in Termux. Use 'deploy' to publish on Cloudflare Workers instead." >&2
  exit 2
fi

for command_name in curl tar node npm; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "Missing required command: $command_name" >&2
    if [[ "$is_termux" == true ]]; then
      echo "In Termux, install prerequisites with: pkg install nodejs-lts curl tar" >&2
    else
      echo "Install Node.js 20+ (including npm), curl, and tar, then rerun this script." >&2
    fi
    exit 1
  fi
done

node_major="$(node -p 'Number(process.versions.node.split(".")[0])')"
if [[ "$node_major" -lt 20 ]]; then
  echo "Node.js 20 or newer is required; found $(node --version)." >&2
  exit 1
fi

if [[ -z "${HOME:-}" || "$INSTALL_DIR" == "/" ]]; then
  echo "Refusing to install into an invalid directory: $INSTALL_DIR" >&2
  exit 1
fi

archive_url="https://codeload.github.com/${OWNER}/${REPO}/tar.gz/refs/heads/${BRANCH}"
tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/sepehr-install.XXXXXX")"
trap 'rm -rf "$tmp_dir"' EXIT

printf 'Downloading Sepehr from GitHub branch %s...\n' "$BRANCH"
curl -fsSL --retry 3 --retry-delay 1 "$archive_url" -o "$tmp_dir/source.tar.gz"
mkdir "$tmp_dir/source"
tar -xzf "$tmp_dir/source.tar.gz" --strip-components=1 -C "$tmp_dir/source"

if [[ -e "$INSTALL_DIR" ]]; then
  if [[ ! -f "$INSTALL_DIR/package.json" ]] || ! grep -Eq '"name"[[:space:]]*:[[:space:]]*"sepehr-worker-browser"' "$INSTALL_DIR/package.json"; then
    echo "Refusing to overwrite the existing directory: $INSTALL_DIR" >&2
    echo "Set SEPEHR_INSTALL_DIR to another path, or move the existing directory first." >&2
    exit 1
  fi
  cp -a "$tmp_dir/source/." "$INSTALL_DIR/"
else
  mkdir -p "$(dirname "$INSTALL_DIR")"
  mv "$tmp_dir/source" "$INSTALL_DIR"
fi

printf 'Installing Node dependencies in %s...\n' "$INSTALL_DIR"
cd "$INSTALL_DIR"
if [[ "$is_termux" == true ]]; then
  echo "Termux has no supported workerd binary; skipping package install hooks for remote deployment."
  npm ci --ignore-scripts
else
  npm ci
fi

case "$MODE" in
  install)
    cat <<NEXT

Source and dependencies are installed.
  Project: $INSTALL_DIR
  Deploy:  cd "$INSTALL_DIR" && npx wrangler login && npm run deploy
  Preview (Linux VPS only): cd "$INSTALL_DIR" && npm run dev

The default Worker configuration requires Google OAuth and keeps the proxy allowlist restricted.
NEXT
    ;;
  deploy)
    cat <<'NOTICE'

Notice: the default configuration requires Google OAuth. Deploying the code does not configure
Google credentials for you; configure OAuth and the allowed account before relying on the proxy.
Do not disable authentication or broaden the host allowlist unless you understand the exposure.
NOTICE
    if ! npx wrangler whoami >/dev/null 2>&1; then
      echo "Cloudflare login is required. Complete the browser authorization prompt..."
      npx wrangler login
    fi
    npm run deploy
    ;;
  dev)
    echo "Starting local Wrangler preview on 0.0.0.0:${PORT}; this is for development, not production."
    exec npx wrangler dev --ip 0.0.0.0 --port "$PORT"
    ;;
esac
