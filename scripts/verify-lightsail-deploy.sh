#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
FILES=(
  "$SCRIPT_DIR/deploy-lightsail.sh"
  "$SCRIPT_DIR/lightsail-remote-deploy.sh"
  "$SCRIPT_DIR/rollback-lightsail.sh"
)

bash -n "${FILES[@]}"
for file in "${FILES[@]}"; do
  "$file" --help >/dev/null
done
if command -v shellcheck >/dev/null 2>&1; then
  shellcheck "${FILES[@]}"
else
  printf 'shellcheck not installed; skipped lint (bash syntax and help checks passed).\n'
fi
