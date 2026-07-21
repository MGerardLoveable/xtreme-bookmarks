# Deploy Xtreme Bookmarks on AWS Lightsail

This production path deploys one exact Git commit into a versioned release directory, serves it only through HTTPS, backs up the database before activation, runs health checks, and supports rollback. The Node service is managed by systemd and nginx proxies `https://DOMAIN` to the app on port 3847.

## Required inputs

Have these values before starting:

| Input | Purpose |
| --- | --- |
| AWS account/profile | Must allow STS plus Lightsail instance, key pair, static IP, and firewall operations |
| Region and availability zone | Defaults are `us-west-2` and `us-west-2a` |
| Domain | A DNS name you control, such as `bookmarks.example.com` |
| DNS A record | Must point the domain to the Lightsail static IP printed by the script |
| Let's Encrypt email | Used for the certificate account and expiry notices |
| `XTREME_BOOKMARKS_WEB_PASSWORD` | Required application password; the script does not generate or print one |
| Local data directory | Explicit directory containing `bookmarks.db`, unless production already has data |
| Commit SHA | Optional full SHA; omitted means the freshly fetched `origin/main` SHA |

The script never deploys a floating branch. If `--commit` is omitted, it fetches `origin/main` once and pins that resulting 40-character SHA. Normally, merge the release PR before deploying so this default selects the reviewed commit.

## Prerequisites

On macOS or Linux install:

- Bash 3.2 or newer
- AWS CLI v2, authenticated with the intended production profile
- `ssh`, `scp`, `git`, `curl`, `tar`, `jq`, and `dig`
- `gzip`, used with `git archive` to create the exact release artifact locally

Confirm AWS identity before making infrastructure changes:

```bash
aws sts get-caller-identity
```

Export the password without placing it in shell history:

```bash
read -s XTREME_BOOKMARKS_WEB_PASSWORD
export XTREME_BOOKMARKS_WEB_PASSWORD
```

The web password must be 16-128 characters from the safe set `A-Z a-z 0-9 . _ ~ ! @ % + = , : -`. The deployment preserves unrelated values already stored in `/etc/xtreme-bookmarks.env`. Configure optional X, xAI, or Brave credentials there separately; the deployment does not invent or copy those secrets.

## First deployment

Run from the repository root with the real local data directory:

```bash
./scripts/deploy-lightsail.sh \
  --domain bookmarks.example.com \
  --email operator@example.com \
  --data-dir /absolute/path/to/xtreme-bookmarks-data
```

On a new instance, the script allocates and prints a static IP, then waits up to ten minutes for the domain's A record to resolve to it. Create or update the DNS record when that IP appears. Rerunning the command is safe if DNS propagation exceeds the wait.

To deploy a reviewed SHA explicitly:

```bash
./scripts/deploy-lightsail.sh \
  --domain bookmarks.example.com \
  --email operator@example.com \
  --commit 0123456789abcdef0123456789abcdef01234567 \
  --data-dir /absolute/path/to/xtreme-bookmarks-data
```

For later code-only releases that must retain production data:

```bash
./scripts/deploy-lightsail.sh \
  --domain bookmarks.example.com \
  --email operator@example.com \
  --skip-data-upload
```

PowerShell delegates to the same hardened Bash implementation so behavior does not drift:

```powershell
$env:XTREME_BOOKMARKS_WEB_PASSWORD = Read-Host -AsSecureString | ConvertFrom-SecureString -AsPlainText
.\scripts\deploy-lightsail.ps1 -Domain bookmarks.example.com -Email operator@example.com -DataDir C:\path\to\data
```

Git Bash or WSL must provide `bash` for that wrapper.

## What deployment does

1. Creates or reuses the Lightsail instance, SSH key, static IP, and ports 80/443.
2. Verifies DNS points to the static IP before requesting a certificate.
3. Creates a release archive from the exact local commit, uploads it without granting the server access to the private GitHub repository, and builds it in `/opt/xtreme-bookmarks/releases/COMMIT_SHA` while the current release remains online.
4. Obtains a Let's Encrypt certificate. Port 80 serves only the ACME challenge and then redirects to HTTPS.
5. Stops the service, verifies and backs up an existing `bookmarks.db`, applies explicitly staged data when supplied, and atomically switches `/opt/xtreme-bookmarks/current`.
6. Starts systemd, checks the local database-aware `/healthz`, reloads nginx, then checks the public HTTPS health endpoint and authenticated app.
7. Keeps the previous symlink and five recent releases for rollback. Deployment metadata records the pre-deploy backup name.

The service firewall exposes only SSH, HTTP, and HTTPS. HTTP redirects to HTTPS before credentials are sent. The certificate renews through `certbot.timer`.

## Verification

Run static checks before deployment:

```bash
./scripts/verify-lightsail-deploy.sh
```

This always runs Bash syntax and help-path checks, and runs ShellCheck when installed.

After deployment:

```bash
curl --fail --proto '=https' --tlsv1.2 https://bookmarks.example.com/healthz
ssh -i .deploy/xtreme-bookmarks-key.pem ubuntu@PUBLIC_IP \
  'sudo systemctl status xtreme-bookmarks --no-pager && sudo nginx -t'
```

The local deployment summary is `.deploy/lightsail-summary.json`. It contains connection metadata but not the web password.

## Rollback

Switch back to the previous application release and run local and public health checks:

```bash
./scripts/rollback-lightsail.sh
```

Select a retained release explicitly:

```bash
./scripts/rollback-lightsail.sh --to-sha 0123456789abcdef0123456789abcdef01234567
```

Application rollback leaves the current database in place. If the failed release performed an incompatible migration, restore the database backup captured immediately before that deployment:

```bash
./scripts/rollback-lightsail.sh --restore-database
```

Database restoration discards writes made after the backup, so it is intentionally opt-in. The restore command uses the exact backup recorded for the release being rolled back.

## Operations

```bash
sudo systemctl status xtreme-bookmarks
sudo journalctl -u xtreme-bookmarks -f
sudo certbot renew --dry-run
readlink -f /opt/xtreme-bookmarks/current
ls -la /opt/xtreme-bookmarks/releases /opt/xtreme-bookmarks-data/backups
```

Browser-session bookmark grabbing still depends on a logged-in desktop browser. Production sync should use explicitly configured supported credentials; do not upload a desktop browser profile to the server.
