#!/bin/sh
set -eu
# Install under /etc/letsencrypt/renewal-hooks/deploy/ with mode 755.
case "${RENEWED_LINEAGE:-}" in
  */xtreme-bookmarks.*)
    /usr/sbin/apache2ctl configtest
    /bin/systemctl reload apache2
    ;;
esac
