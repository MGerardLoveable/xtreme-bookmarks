#!/bin/bash
set -euo pipefail
umask 077
exec 9>/run/xtreme-bookmarks-backup.lock
flock -n 9 || exit 0
destination=/var/backups/xtreme-bookmarks
install -d -m 700 "$destination"
resume=0
cleanup() {
  if [ "$resume" = 1 ]; then systemctl start xtreme-bookmarks; fi
}
trap cleanup EXIT
if systemctl is-active --quiet xtreme-bookmarks; then
  resume=1
  systemctl stop xtreme-bookmarks
fi
name="backup-$(date -u +%Y%m%dT%H%M%SZ).tar.gz"
tar -czf "$destination/$name.partial" --exclude=data/backups \
  -C /var/lib/xtreme-bookmarks data \
  -C /etc xtreme-bookmarks
tar -tzf "$destination/$name.partial" >/dev/null
mv "$destination/$name.partial" "$destination/$name"
# Keep a bounded local recovery window; off-host copies remain essential.
find "$destination" -maxdepth 1 -name 'backup-*.tar.gz' -mtime +7 -delete
echo "Verified backup: $name"
