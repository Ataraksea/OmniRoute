#!/usr/bin/env bash
# Local dev bootstrap: correct Node version, native modules, then start OmniRoute.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

MIN_NODE_MAJOR=22

use_nvm() {
  if [[ -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ]]; then
    # shellcheck source=/dev/null
    . "${NVM_DIR:-$HOME/.nvm}/nvm.sh"
    if [[ -f .nvmrc ]]; then
      nvm install
      nvm use
    fi
  fi
}

node_major() {
  node -p "process.versions.node.split('.')[0]" 2>/dev/null || echo 0
}

echo "==> OmniRoute local setup"
use_nvm

MAJOR="$(node_major)"
if [[ "$MAJOR" -lt "$MIN_NODE_MAJOR" ]]; then
  echo "ERROR: Node $(node -v) is too old. Need Node >= ${MIN_NODE_MAJOR} (see .nvmrc)."
  echo "  Install: nvm install 24 && nvm use"
  exit 1
fi

echo "    Node: $(node -v)"
echo "    npm:  $(npm -v)"

if [[ ! -d node_modules ]]; then
  echo "==> npm install"
  npm install
fi

echo "==> Rebuild native modules (better-sqlite3)"
npm rebuild better-sqlite3

if [[ ! -f .env ]]; then
  echo "==> Creating .env from .env.example"
  cp .env.example .env
  if command -v openssl >/dev/null 2>&1; then
    {
      echo ""
      echo "JWT_SECRET=$(openssl rand -base64 48)"
      echo "API_KEY_SECRET=$(openssl rand -hex 32)"
    } >> .env
    echo "    Generated JWT_SECRET and API_KEY_SECRET in .env"
  fi
  echo "    Set INITIAL_PASSWORD in .env before first login."
fi

echo "==> Starting dev server at http://localhost:${PORT:-20128}"
echo "    Dashboard: http://localhost:${PORT:-20128}/dashboard"
echo "    Press Ctrl+C to stop."
exec npm run dev
