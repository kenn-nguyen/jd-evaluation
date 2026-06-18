#!/bin/bash
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR" || exit 1

# Prefer IPv4 for Node-based Google API calls. This avoids auth timeouts on
# some VPN/DNS setups where curl works but Node/undici stalls or fails.
if [[ -n "${NODE_OPTIONS:-}" ]]; then
  export NODE_OPTIONS="$NODE_OPTIONS --dns-result-order=ipv4first"
else
  export NODE_OPTIONS="--dns-result-order=ipv4first"
fi

echo "Apps Script sync"
echo "Project: $SCRIPT_DIR"
echo "Node options: $NODE_OPTIONS"
echo

if ! command -v clasp >/dev/null 2>&1; then
  echo "clasp is not installed."
  echo "Install it with: npm install -g @google/clasp"
  echo
  read -r -p "Press Enter to close..."
  exit 1
fi

if ! clasp show-authorized-user >/dev/null 2>&1; then
  echo "No clasp credentials found. Starting clasp login..."
  echo
  clasp login
  echo
fi

echo "Pushing local Apps Script files..."
echo

if clasp push; then
  echo
  echo "Push completed."
else
  echo
  echo "Push failed."
  exit_code=$?
  echo "Exit code: $exit_code"
  echo
  read -r -p "Press Enter to close..."
  exit "$exit_code"
fi

echo
read -r -p "Press Enter to close..."
