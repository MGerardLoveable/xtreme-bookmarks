#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
PROJECT_DIR=$(cd -- "$SCRIPT_DIR/.." && pwd)
DEPLOY_DIR="$PROJECT_DIR/.deploy"

INSTANCE_NAME=xtreme-bookmarks
REGION=us-west-2
AVAILABILITY_ZONE=us-west-2a
BLUEPRINT_ID=ubuntu_24_04
BUNDLE_ID=micro_3_0
STATIC_IP_NAME=xtreme-bookmarks-ip
WEB_USER=xtreme
DOMAIN=
CERT_EMAIL=
COMMIT_SHA=
LOCAL_DATA_DIR=
SKIP_DATA_UPLOAD=0
DNS_WAIT_SECONDS=600

usage() {
  cat <<'EOF'
Usage: scripts/deploy-lightsail.sh --domain DOMAIN --email EMAIL [options]

Required:
  --domain DOMAIN          DNS name whose A record points to the Lightsail static IP
  --email EMAIL            Let's Encrypt account and expiry-notification email
  XTREME_BOOKMARKS_WEB_PASSWORD must be present in the environment

Release and data:
  --commit SHA             Full commit SHA (default: freshly fetched origin/main)
  --data-dir PATH          Explicit local Xtreme Bookmarks data directory
  --skip-data-upload       Reuse data already present on the instance

AWS options:
  --instance-name NAME     Default: xtreme-bookmarks
  --region REGION          Default: us-west-2
  --availability-zone AZ   Default: us-west-2a
  --blueprint-id ID        Default: ubuntu_24_04
  --bundle-id ID           Default: micro_3_0
  --static-ip-name NAME    Default: xtreme-bookmarks-ip
  --web-user USER          Default: xtreme
  --dns-wait SECONDS       Default: 600
EOF
}

KEY_JSON=
USER_DATA=
ENV_FILE=
DATA_ARCHIVE=
RELEASE_ARCHIVE=
cleanup() {
  [[ -z $KEY_JSON ]] || rm -f "$KEY_JSON"
  [[ -z $USER_DATA ]] || rm -f "$USER_DATA"
  [[ -z $ENV_FILE ]] || rm -f "$ENV_FILE"
  [[ -z $DATA_ARCHIVE ]] || rm -f "$DATA_ARCHIVE"
  [[ -z $RELEASE_ARCHIVE ]] || rm -f "$RELEASE_ARCHIVE"
}
trap cleanup EXIT

fail() { printf 'deploy: %s\n' "$*" >&2; exit 1; }
require_command() { command -v "$1" >/dev/null 2>&1 || fail "$1 is required but was not found on PATH"; }

while (($#)); do
  case "$1" in
    --domain) DOMAIN=${2:?}; shift 2 ;;
    --email) CERT_EMAIL=${2:?}; shift 2 ;;
    --commit) COMMIT_SHA=${2:?}; shift 2 ;;
    --data-dir) LOCAL_DATA_DIR=${2:?}; shift 2 ;;
    --skip-data-upload) SKIP_DATA_UPLOAD=1; shift ;;
    --instance-name) INSTANCE_NAME=${2:?}; shift 2 ;;
    --region) REGION=${2:?}; shift 2 ;;
    --availability-zone) AVAILABILITY_ZONE=${2:?}; shift 2 ;;
    --blueprint-id) BLUEPRINT_ID=${2:?}; shift 2 ;;
    --bundle-id) BUNDLE_ID=${2:?}; shift 2 ;;
    --static-ip-name) STATIC_IP_NAME=${2:?}; shift 2 ;;
    --web-user) WEB_USER=${2:?}; shift 2 ;;
    --dns-wait) DNS_WAIT_SECONDS=${2:?}; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) fail "unknown option: $1" ;;
  esac
done

[[ $DOMAIN =~ ^[A-Za-z0-9.-]+$ && $DOMAIN == *.* ]] || fail '--domain must be a valid DNS name'
[[ $CERT_EMAIL =~ ^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$ ]] || fail '--email must be a valid email address'
[[ $WEB_USER =~ ^[A-Za-z0-9._-]+$ ]] || fail '--web-user contains unsupported characters'
[[ $DNS_WAIT_SECONDS =~ ^[0-9]+$ ]] || fail '--dns-wait must be an integer'
[[ -n ${XTREME_BOOKMARKS_WEB_PASSWORD:-} ]] || fail 'set XTREME_BOOKMARKS_WEB_PASSWORD; production access cannot be anonymous'
[[ ${#XTREME_BOOKMARKS_WEB_PASSWORD} -ge 16 && ${#XTREME_BOOKMARKS_WEB_PASSWORD} -le 128 ]] || fail 'XTREME_BOOKMARKS_WEB_PASSWORD must be 16-128 characters'
[[ $XTREME_BOOKMARKS_WEB_PASSWORD =~ ^[A-Za-z0-9._~!@%+=,:-]+$ ]] || fail 'XTREME_BOOKMARKS_WEB_PASSWORD contains unsupported characters'

for command in aws ssh scp tar gzip git curl jq dig openssl; do require_command "$command"; done
aws sts get-caller-identity >/dev/null || fail 'AWS authentication failed; configure an AWS CLI profile or environment credentials'

if [[ -z $COMMIT_SHA ]]; then
  git -C "$PROJECT_DIR" fetch origin main
  COMMIT_SHA=$(git -C "$PROJECT_DIR" rev-parse origin/main)
fi
COMMIT_SHA=$(printf '%s' "$COMMIT_SHA" | tr '[:upper:]' '[:lower:]')
[[ $COMMIT_SHA =~ ^[0-9a-f]{40}$ ]] || fail '--commit must be a full 40-character SHA'
git -C "$PROJECT_DIR" cat-file -e "$COMMIT_SHA^{commit}" 2>/dev/null || fail "commit is not available locally: $COMMIT_SHA"
RELEASE_ARCHIVE="$DEPLOY_DIR/release-$COMMIT_SHA.tar.gz"
git -C "$PROJECT_DIR" archive --format=tar "$COMMIT_SHA" | gzip -9 >"$RELEASE_ARCHIVE"
chmod 0600 "$RELEASE_ARCHIVE"

if ((SKIP_DATA_UPLOAD == 0)); then
  [[ -n $LOCAL_DATA_DIR ]] || fail 'provide --data-dir PATH or use --skip-data-upload'
  LOCAL_DATA_DIR=$(cd -- "$LOCAL_DATA_DIR" 2>/dev/null && pwd) || fail "data directory not found: $LOCAL_DATA_DIR"
  [[ -f $LOCAL_DATA_DIR/bookmarks.db ]] || fail "bookmarks.db not found in data directory: $LOCAL_DATA_DIR"
fi

mkdir -p "$DEPLOY_DIR"
chmod 0700 "$DEPLOY_DIR"
KEY_NAME="$INSTANCE_NAME-key"
KEY_PATH="$DEPLOY_DIR/$KEY_NAME.pem"

if ! aws lightsail get-key-pair --region "$REGION" --key-pair-name "$KEY_NAME" >/dev/null 2>&1; then
  KEY_JSON=$(mktemp "$DEPLOY_DIR/key.XXXXXX")
  aws lightsail create-key-pair --region "$REGION" --key-pair-name "$KEY_NAME" >"$KEY_JSON"
  jq -r '.privateKeyBase64' "$KEY_JSON" >"$KEY_PATH"
  if ! grep -q '^-----BEGIN ' "$KEY_PATH"; then
    openssl base64 -d -A -in "$KEY_PATH" -out "$KEY_PATH.decoded"
    mv "$KEY_PATH.decoded" "$KEY_PATH"
  fi
  chmod 0600 "$KEY_PATH"
elif [[ ! -f $KEY_PATH ]]; then
  fail "Lightsail key pair $KEY_NAME exists but $KEY_PATH is missing; recover the key or choose another instance name"
fi

USER_DATA=$(mktemp "$DEPLOY_DIR/user-data.XXXXXX")
cat >"$USER_DATA" <<'EOF'
#!/usr/bin/env bash
set -eux
apt-get update
apt-get install -y ca-certificates curl openssh-server
install -d -o ubuntu -g ubuntu -m 0755 /opt/xtreme-bookmarks
EOF

if ! aws lightsail get-instance --region "$REGION" --instance-name "$INSTANCE_NAME" >/dev/null 2>&1; then
  aws lightsail create-instances \
    --region "$REGION" \
    --instance-names "$INSTANCE_NAME" \
    --availability-zone "$AVAILABILITY_ZONE" \
    --blueprint-id "$BLUEPRINT_ID" \
    --bundle-id "$BUNDLE_ID" \
    --key-pair-name "$KEY_NAME" \
    --user-data "file://$USER_DATA" >/dev/null
fi

for port in 80 443; do
  aws lightsail open-instance-public-ports --region "$REGION" --instance-name "$INSTANCE_NAME" \
    --port-info "fromPort=$port,toPort=$port,protocol=TCP" >/dev/null
done

if ! aws lightsail get-static-ip --region "$REGION" --static-ip-name "$STATIC_IP_NAME" >/dev/null 2>&1; then
  aws lightsail allocate-static-ip --region "$REGION" --static-ip-name "$STATIC_IP_NAME" >/dev/null
fi
ATTACHED_TO=$(aws lightsail get-static-ip --region "$REGION" --static-ip-name "$STATIC_IP_NAME" --query 'staticIp.attachedTo' --output text)
if [[ $ATTACHED_TO != "$INSTANCE_NAME" ]]; then
  [[ $ATTACHED_TO == None ]] || fail "static IP $STATIC_IP_NAME is attached to another instance: $ATTACHED_TO"
  aws lightsail attach-static-ip --region "$REGION" --static-ip-name "$STATIC_IP_NAME" --instance-name "$INSTANCE_NAME" >/dev/null
fi
PUBLIC_IP=$(aws lightsail get-static-ip --region "$REGION" --static-ip-name "$STATIC_IP_NAME" --query 'staticIp.ipAddress' --output text)
[[ $PUBLIC_IP =~ ^[0-9a-fA-F:.]+$ ]] || fail 'Lightsail did not return a valid static IP'

printf 'Static IP: %s\nWaiting for %s DNS to resolve to that address...\n' "$PUBLIC_IP" "$DOMAIN"
deadline=$((SECONDS + DNS_WAIT_SECONDS))
until dig +short A "$DOMAIN" | grep -Fx "$PUBLIC_IP" >/dev/null; do
  ((SECONDS < deadline)) || fail "DNS is not ready. Create/update the A record for $DOMAIN to $PUBLIC_IP, then rerun"
  sleep 10
done

SSH=(ssh -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 -i "$KEY_PATH" "ubuntu@$PUBLIC_IP")
SCP=(scp -o StrictHostKeyChecking=accept-new -i "$KEY_PATH")
for _ in {1..60}; do
  if "${SSH[@]}" true 2>/dev/null; then break; fi
  sleep 10
done
"${SSH[@]}" true || fail 'SSH did not become ready'

REMOTE_SCRIPT=/tmp/xtreme-bookmarks-remote-deploy.sh
"${SCP[@]}" "$SCRIPT_DIR/lightsail-remote-deploy.sh" "ubuntu@$PUBLIC_IP:$REMOTE_SCRIPT"
"${SSH[@]}" sudo install -o root -g root -m 0700 "$REMOTE_SCRIPT" /root/xtreme-bookmarks-remote-deploy.sh
"${SCP[@]}" "$RELEASE_ARCHIVE" "ubuntu@$PUBLIC_IP:/tmp/xtreme-bookmarks-release.tar.gz"

ENV_FILE=$(mktemp "$DEPLOY_DIR/deploy-env.XXXXXX")
chmod 0600 "$ENV_FILE"
{
  printf 'XTREME_BOOKMARKS_NO_OPEN=1\n'
  printf 'XTREME_BOOKMARKS_DATA_DIR=/opt/xtreme-bookmarks-data\n'
  printf 'XTREME_BOOKMARKS_WEB_HOST=0.0.0.0\n'
  printf 'XTREME_BOOKMARKS_WEB_USER=%s\n' "$WEB_USER"
  printf 'XTREME_BOOKMARKS_WEB_PASSWORD=%s\n' "$XTREME_BOOKMARKS_WEB_PASSWORD"
  printf 'XTREME_BOOKMARKS_CORS_ORIGINS=https://%s\n' "$DOMAIN"
  printf 'X_CALLBACK_URL=https://%s/auth/callback\n' "$DOMAIN"
} >"$ENV_FILE"
"${SCP[@]}" "$ENV_FILE" "ubuntu@$PUBLIC_IP:/tmp/xtreme-bookmarks-deploy.env"
"${SSH[@]}" chmod 0600 /tmp/xtreme-bookmarks-deploy.env

if ((SKIP_DATA_UPLOAD == 0)); then
  DATA_ARCHIVE="$DEPLOY_DIR/data-$COMMIT_SHA.tar.gz"
  tar -C "$LOCAL_DATA_DIR" -czf "$DATA_ARCHIVE" .
  chmod 0600 "$DATA_ARCHIVE"
  "${SCP[@]}" "$DATA_ARCHIVE" "ubuntu@$PUBLIC_IP:/tmp/xtreme-bookmarks-data.tar.gz"
fi

if ((SKIP_DATA_UPLOAD == 0)); then
  "${SSH[@]}" sudo bash /root/xtreme-bookmarks-remote-deploy.sh \
    --commit "$COMMIT_SHA" \
    --domain "$DOMAIN" \
    --email "$CERT_EMAIL" \
    --release-archive /tmp/xtreme-bookmarks-release.tar.gz \
    --data-archive /tmp/xtreme-bookmarks-data.tar.gz
else
  "${SSH[@]}" sudo bash /root/xtreme-bookmarks-remote-deploy.sh \
    --commit "$COMMIT_SHA" \
    --domain "$DOMAIN" \
    --email "$CERT_EMAIL" \
    --release-archive /tmp/xtreme-bookmarks-release.tar.gz
fi

curl --fail --silent --show-error --proto '=https' --tlsv1.2 "https://$DOMAIN/healthz" >/dev/null
curl --fail --silent --show-error --proto '=https' --tlsv1.2 --user "$WEB_USER:$XTREME_BOOKMARKS_WEB_PASSWORD" "https://$DOMAIN/" >/dev/null

SUMMARY="$DEPLOY_DIR/lightsail-summary.json"
jq -n \
  --arg instanceName "$INSTANCE_NAME" \
  --arg region "$REGION" \
  --arg publicIp "$PUBLIC_IP" \
  --arg domain "$DOMAIN" \
  --arg commit "$COMMIT_SHA" \
  --arg webUser "$WEB_USER" \
  --arg keyPath "$KEY_PATH" \
  '{instanceName:$instanceName,region:$region,publicIp:$publicIp,domain:$domain,url:("https://"+$domain+"/"),commit:$commit,webUser:$webUser,keyPath:$keyPath}' >"$SUMMARY"
chmod 0600 "$SUMMARY"

printf '\nDeployment complete\n  URL: https://%s/\n  Commit: %s\n  Summary: %s\n' "$DOMAIN" "$COMMIT_SHA" "$SUMMARY"
