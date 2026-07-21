#!/usr/bin/env bash
set -Eeuo pipefail

APP_ROOT=/opt/xtreme-bookmarks
DATA_DIR=/opt/xtreme-bookmarks-data
SERVICE=xtreme-bookmarks
APP_PORT=3847
KEEP_RELEASES=5

usage() {
  cat <<'EOF'
Usage: lightsail-remote-deploy.sh --commit SHA --domain DOMAIN --email EMAIL --release-archive PATH [--data-archive PATH]
EOF
}

fail() {
  printf 'remote deploy: %s\n' "$*" >&2
  exit 1
}

COMMIT_SHA=
DOMAIN=
EMAIL=
RELEASE_ARCHIVE=
DATA_ARCHIVE=
while (($#)); do
  case "$1" in
    --commit) COMMIT_SHA=${2:?}; shift 2 ;;
    --domain) DOMAIN=${2:?}; shift 2 ;;
    --email) EMAIL=${2:?}; shift 2 ;;
    --release-archive) RELEASE_ARCHIVE=${2:?}; shift 2 ;;
    --data-archive) DATA_ARCHIVE=${2:?}; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) fail "unknown option: $1" ;;
  esac
done

[[ $EUID -eq 0 ]] || fail 'run as root'
[[ $COMMIT_SHA =~ ^[0-9a-f]{40}$ ]] || fail 'commit must be a full 40-character lowercase SHA'
[[ $DOMAIN =~ ^[A-Za-z0-9.-]+$ && $DOMAIN == *.* ]] || fail 'invalid domain'
[[ $EMAIL =~ ^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$ ]] || fail 'invalid certificate email'
[[ -f $RELEASE_ARCHIVE ]] || fail 'staged release archive is missing'
[[ -f /tmp/xtreme-bookmarks-deploy.env ]] || fail 'deployment environment file is missing'

RELEASE_DIR="$APP_ROOT/releases/$COMMIT_SHA"
DEPLOYMENT_DIR="$APP_ROOT/deployments/$COMMIT_SHA"
CURRENT_RELEASE=$(readlink -f "$APP_ROOT/current" 2>/dev/null || true)
PREVIOUS_RELEASE=$CURRENT_RELEASE
BACKUP_NAME=
ACTIVATED=0
SERVICE_STOPPED=0
DATA_REPLACED=0
RELEASE_STAGE=

rollback_failed_activation() {
  local exit_code=$?
  trap - ERR
  [[ -z $RELEASE_STAGE ]] || rm -rf "$RELEASE_STAGE"
  systemctl stop "$SERVICE" 2>/dev/null || true
  if [[ -n $BACKUP_NAME ]] && ((ACTIVATED || DATA_REPLACED)); then
    runuser -u ubuntu -- env XTREME_BOOKMARKS_DATA_DIR="$DATA_DIR" node "$RELEASE_DIR/bin/xb.mjs" backups restore "$BACKUP_NAME" --yes 2>/dev/null || true
  fi
  if ((ACTIVATED)) && [[ -n $PREVIOUS_RELEASE && -d $PREVIOUS_RELEASE ]]; then
    printf 'Activation failed; returning to %s\n' "$PREVIOUS_RELEASE" >&2
    ln -sfn "$PREVIOUS_RELEASE" "$APP_ROOT/current.next"
    mv -Tf "$APP_ROOT/current.next" "$APP_ROOT/current"
    systemctl start "$SERVICE" 2>/dev/null || true
  elif ((ACTIVATED)); then
    systemctl stop "$SERVICE" 2>/dev/null || true
    rm -f "$APP_ROOT/current"
  elif ((SERVICE_STOPPED)) && [[ -n $CURRENT_RELEASE ]]; then
    systemctl start "$SERVICE" 2>/dev/null || true
  fi
  exit "$exit_code"
}
trap rollback_failed_activation ERR

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y ca-certificates curl git nginx certbot python3-certbot-nginx rsync ufw
if ! command -v node >/dev/null || [[ $(node --version | tr -d v | cut -d. -f1) -lt 22 ]]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

if [[ ! -f /swapfile ]]; then
  fallocate -l 1G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  printf '/swapfile none swap sw 0 0\n' >>/etc/fstab
else
  swapon /swapfile 2>/dev/null || true
fi

install -d -o ubuntu -g ubuntu -m 0755 "$APP_ROOT/releases" "$APP_ROOT/deployments"
install -d -o ubuntu -g ubuntu -m 0700 "$DATA_DIR"

if [[ ! -d $RELEASE_DIR ]]; then
  RELEASE_STAGE=$(mktemp -d "$APP_ROOT/release-stage.XXXXXX")
  chown ubuntu:ubuntu "$RELEASE_STAGE"
  runuser -u ubuntu -- tar -xzf "$RELEASE_ARCHIVE" -C "$RELEASE_STAGE"
  printf '%s\n' "$COMMIT_SHA" >"$RELEASE_STAGE/.release-sha"
  chown ubuntu:ubuntu "$RELEASE_STAGE/.release-sha"
  runuser -u ubuntu -- npm --prefix "$RELEASE_STAGE" ci --ignore-scripts
  runuser -u ubuntu -- npm --prefix "$RELEASE_STAGE" run build
  mv "$RELEASE_STAGE" "$RELEASE_DIR"
  RELEASE_STAGE=
fi
rm -f "$RELEASE_ARCHIVE"

systemctl enable --now nginx
if [[ ! -s /etc/letsencrypt/live/$DOMAIN/fullchain.pem ]]; then
  install -d -m 0755 /var/www/certbot
  cat >/etc/nginx/sites-available/xtreme-bookmarks-bootstrap <<EOF
server {
  listen 80;
  listen [::]:80;
  server_name $DOMAIN;
  location ^~ /.well-known/acme-challenge/ { root /var/www/certbot; }
  location / { return 503; }
}
EOF
  rm -f /etc/nginx/sites-enabled/default /etc/nginx/sites-enabled/xtreme-bookmarks
  ln -sfn /etc/nginx/sites-available/xtreme-bookmarks-bootstrap /etc/nginx/sites-enabled/xtreme-bookmarks-bootstrap
  nginx -t
  systemctl reload nginx
  certbot certonly --webroot -w /var/www/certbot --non-interactive --agree-tos --no-eff-email --email "$EMAIL" -d "$DOMAIN"
fi

systemctl stop "$SERVICE" 2>/dev/null || true
SERVICE_STOPPED=1
if [[ -f $DATA_DIR/bookmarks.db ]]; then
  BEFORE_BACKUP=$(find "$DATA_DIR/backups" -maxdepth 1 -type f -name '*.bak' -printf '%f\n' 2>/dev/null | sort || true)
  runuser -u ubuntu -- env XTREME_BOOKMARKS_DATA_DIR="$DATA_DIR" node "$RELEASE_DIR/bin/xb.mjs" backup
  AFTER_BACKUP=$(find "$DATA_DIR/backups" -maxdepth 1 -type f -name '*.bak' -printf '%f\n' 2>/dev/null | sort || true)
  BACKUP_NAME=$(comm -13 <(printf '%s\n' "$BEFORE_BACKUP") <(printf '%s\n' "$AFTER_BACKUP") | tail -1)
  [[ -n $BACKUP_NAME ]] || BACKUP_NAME=$(find "$DATA_DIR/backups" -maxdepth 1 -type f -name '*.bak' -printf '%T@ %f\n' | sort -nr | head -1 | cut -d' ' -f2-)
  [[ -n $BACKUP_NAME ]] || fail 'pre-deploy database backup was not created'
fi

if [[ -n $DATA_ARCHIVE ]]; then
  [[ -f $DATA_ARCHIVE ]] || fail 'staged data archive is missing'
  STAGED_DATA=$(mktemp -d "$APP_ROOT/data-stage.XXXXXX")
  tar -xzf "$DATA_ARCHIVE" -C "$STAGED_DATA"
  rm -f "$DATA_ARCHIVE"
  rsync -a "$STAGED_DATA/" "$DATA_DIR/"
  DATA_REPLACED=1
  rm -rf "$STAGED_DATA"
fi
[[ -f $DATA_DIR/bookmarks.db ]] || fail 'no bookmarks.db exists; deploy with an explicit data directory'
chown -R ubuntu:ubuntu "$DATA_DIR"
chmod 0700 "$DATA_DIR"

install -d -m 0755 "$DEPLOYMENT_DIR"
printf '%s\n' "$PREVIOUS_RELEASE" >"$DEPLOYMENT_DIR/previous-release"
printf '%s\n' "$BACKUP_NAME" >"$DEPLOYMENT_DIR/backup-name"
chmod 0644 "$DEPLOYMENT_DIR/previous-release" "$DEPLOYMENT_DIR/backup-name"

if [[ -f /etc/xtreme-bookmarks.env ]]; then
  awk -F= '!/^(XTREME_BOOKMARKS_NO_OPEN|XTREME_BOOKMARKS_DATA_DIR|XTREME_BOOKMARKS_WEB_HOST|XTREME_BOOKMARKS_WEB_USER|XTREME_BOOKMARKS_WEB_PASSWORD|XTREME_BOOKMARKS_CORS_ORIGINS|X_CALLBACK_URL)=/' /etc/xtreme-bookmarks.env > /tmp/xtreme-bookmarks-preserved.env
else
  : >/tmp/xtreme-bookmarks-preserved.env
fi
cat /tmp/xtreme-bookmarks-preserved.env /tmp/xtreme-bookmarks-deploy.env >/etc/xtreme-bookmarks.env
rm -f /tmp/xtreme-bookmarks-preserved.env /tmp/xtreme-bookmarks-deploy.env
chown root:root /etc/xtreme-bookmarks.env
chmod 0600 /etc/xtreme-bookmarks.env

cat >/etc/systemd/system/xtreme-bookmarks.service <<EOF
[Unit]
Description=Xtreme Bookmarks
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=$APP_ROOT/current
EnvironmentFile=/etc/xtreme-bookmarks.env
ExecStart=/usr/bin/node $APP_ROOT/current/bin/xb.mjs web --port $APP_PORT
Restart=always
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=$DATA_DIR

[Install]
WantedBy=multi-user.target
EOF

cat >/etc/nginx/sites-available/xtreme-bookmarks <<EOF
server {
  listen 80;
  listen [::]:80;
  server_name $DOMAIN;
  location ^~ /.well-known/acme-challenge/ { root /var/www/certbot; }
  location / { return 301 https://\$host\$request_uri; }
}

server {
  listen 443 ssl http2;
  listen [::]:443 ssl http2;
  server_name $DOMAIN;

  ssl_certificate /etc/letsencrypt/live/$DOMAIN/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/$DOMAIN/privkey.pem;
  ssl_protocols TLSv1.2 TLSv1.3;
  ssl_session_cache shared:SSL:10m;
  ssl_session_timeout 1d;
  add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;

  client_max_body_size 1m;
  location / {
    proxy_pass http://127.0.0.1:$APP_PORT;
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto https;
    proxy_read_timeout 300s;
  }
}
EOF
rm -f /etc/nginx/sites-enabled/xtreme-bookmarks-bootstrap
ln -sfn /etc/nginx/sites-available/xtreme-bookmarks /etc/nginx/sites-enabled/xtreme-bookmarks
nginx -t

if [[ -n $PREVIOUS_RELEASE ]]; then
  ln -sfn "$PREVIOUS_RELEASE" "$APP_ROOT/previous"
fi
ln -sfn "$RELEASE_DIR" "$APP_ROOT/current.next"
mv -Tf "$APP_ROOT/current.next" "$APP_ROOT/current"
ACTIVATED=1

systemctl daemon-reload
systemctl enable "$SERVICE"
systemctl restart "$SERVICE"
SERVICE_STOPPED=0
for _ in {1..30}; do
  if curl -fsS "http://127.0.0.1:$APP_PORT/healthz" >/dev/null; then break; fi
  sleep 2
done
curl -fsS "http://127.0.0.1:$APP_PORT/healthz" >/dev/null
systemctl reload nginx
systemctl enable --now certbot.timer

ufw allow OpenSSH
ufw allow 'Nginx Full'
ufw deny "$APP_PORT/tcp"
ufw --force enable

ACTIVATED=0
trap - ERR
find "$APP_ROOT/releases" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' \
  | sort -nr | tail -n +$((KEEP_RELEASES + 1)) | cut -d' ' -f2- \
  | while IFS= read -r old_release; do
      [[ $old_release == "$(readlink -f "$APP_ROOT/current")" ]] && continue
      [[ $old_release == "$(readlink -f "$APP_ROOT/previous" 2>/dev/null || true)" ]] && continue
      rm -rf "$old_release"
    done

printf 'Activated release %s\n' "$COMMIT_SHA"
