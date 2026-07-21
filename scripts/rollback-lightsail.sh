#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
PROJECT_DIR=$(cd -- "$SCRIPT_DIR/.." && pwd)
SUMMARY="$PROJECT_DIR/.deploy/lightsail-summary.json"
TARGET_SHA=
RESTORE_DATABASE=0

usage() {
  cat <<'EOF'
Usage: scripts/rollback-lightsail.sh [--to-sha SHA] [--restore-database]

By default, switches to the server's previous release. Database restoration is
separate and opt-in because it discards writes made after the deployment.
EOF
}

fail() { printf 'rollback: %s\n' "$*" >&2; exit 1; }
while (($#)); do
  case "$1" in
    --to-sha) TARGET_SHA=${2:?}; shift 2 ;;
    --restore-database) RESTORE_DATABASE=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) fail "unknown option: $1" ;;
  esac
done

command -v jq >/dev/null || fail 'jq is required'
command -v ssh >/dev/null || fail 'ssh is required'
[[ -f $SUMMARY ]] || fail "deployment summary not found: $SUMMARY"
PUBLIC_IP=$(jq -er '.publicIp' "$SUMMARY")
KEY_PATH=$(jq -er '.keyPath' "$SUMMARY")
[[ -f $KEY_PATH ]] || fail "SSH key not found: $KEY_PATH"
if [[ -n $TARGET_SHA ]]; then
  TARGET_SHA=$(printf '%s' "$TARGET_SHA" | tr '[:upper:]' '[:lower:]')
  [[ $TARGET_SHA =~ ^[0-9a-f]{40}$ ]] || fail '--to-sha must be a full 40-character SHA'
else
  TARGET_SHA=previous
fi

SSH=(ssh -o StrictHostKeyChecking=accept-new -i "$KEY_PATH" "ubuntu@$PUBLIC_IP")
"${SSH[@]}" sudo bash -s -- "$TARGET_SHA" "$RESTORE_DATABASE" <<'REMOTE'
set -Eeuo pipefail
APP_ROOT=/opt/xtreme-bookmarks
DATA_DIR=/opt/xtreme-bookmarks-data
TARGET_SHA=${1:-}
RESTORE_DATABASE=${2:-0}
CURRENT_RELEASE=$(readlink -f "$APP_ROOT/current")
CURRENT_SHA=$(basename "$CURRENT_RELEASE")
SWITCHED=0
recover_current() {
  local exit_code=$?
  trap - ERR
  if ((SWITCHED)); then
    ln -sfn "$CURRENT_RELEASE" "$APP_ROOT/current.next"
    mv -Tf "$APP_ROOT/current.next" "$APP_ROOT/current"
  fi
  systemctl start xtreme-bookmarks 2>/dev/null || true
  exit "$exit_code"
}
trap recover_current ERR
if [[ $TARGET_SHA != previous ]]; then
  TARGET_RELEASE="$APP_ROOT/releases/$TARGET_SHA"
else
  TARGET_RELEASE=$(readlink -f "$APP_ROOT/previous" 2>/dev/null || true)
fi
[[ -n $TARGET_RELEASE && -d $TARGET_RELEASE ]] || { echo 'Rollback target release does not exist.' >&2; exit 1; }
[[ $TARGET_RELEASE == "$APP_ROOT/releases/"* ]] || { echo 'Rollback target is outside the release directory.' >&2; exit 1; }

BACKUP_NAME=$(cat "$APP_ROOT/deployments/$CURRENT_SHA/backup-name" 2>/dev/null || true)
if ((RESTORE_DATABASE)) && [[ -z $BACKUP_NAME ]]; then
  echo "No pre-deploy database backup is recorded for $CURRENT_SHA." >&2
  exit 1
fi

systemctl stop xtreme-bookmarks
if ((RESTORE_DATABASE)); then
  runuser -u ubuntu -- env XTREME_BOOKMARKS_DATA_DIR="$DATA_DIR" node "$TARGET_RELEASE/bin/xb.mjs" backups restore "$BACKUP_NAME" --yes
fi
ln -sfn "$TARGET_RELEASE" "$APP_ROOT/current.next"
mv -Tf "$APP_ROOT/current.next" "$APP_ROOT/current"
SWITCHED=1
ln -sfn "$CURRENT_RELEASE" "$APP_ROOT/previous"
systemctl start xtreme-bookmarks
for _ in {1..30}; do
  if curl -fsS http://127.0.0.1:3847/healthz >/dev/null; then break; fi
  sleep 2
done
curl -fsS http://127.0.0.1:3847/healthz >/dev/null
SWITCHED=0
trap - ERR
printf 'Rolled back from %s to %s\n' "$CURRENT_SHA" "$(basename "$TARGET_RELEASE")"
REMOTE

DOMAIN=$(jq -er '.domain' "$SUMMARY")
curl --fail --silent --show-error --proto '=https' --tlsv1.2 "https://$DOMAIN/healthz" >/dev/null
printf 'Rollback smoke test passed: https://%s/healthz\n' "$DOMAIN"
