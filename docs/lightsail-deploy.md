# Deploy Xtreme Bookmarks on AWS Lightsail

This deploys Xtreme Bookmarks to a Lightsail Ubuntu instance so the web app is reachable from any device.

The server is protected with Basic Auth when `XTREME_BOOKMARKS_WEB_PASSWORD` is set. Local use remains unchanged if that variable is absent.

## Prerequisites

- AWS CLI installed and logged in with access to Lightsail.
- OpenSSH client available on Windows.
- The GitHub repo is reachable by the instance.

Log in to AWS first:

```powershell
aws login
```

## One-command deploy

From the project root:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\deploy-lightsail.ps1
```

The script will:

- Create or reuse a Lightsail Ubuntu instance named `xtreme-bookmarks`.
- Create a local SSH key under `.deploy/`.
- Install Node.js, nginx, and the app.
- Upload your local `~/.xtreme-bookmarks` data directory.
- Start `xtreme-bookmarks` as a systemd service.
- Print the public URL and generated login password.

## Useful commands

SSH into the server:

```powershell
ssh -i .\.deploy\xtreme-bookmarks-key.pem ubuntu@PUBLIC_IP
```

Check the service:

```bash
sudo systemctl status xtreme-bookmarks
sudo journalctl -u xtreme-bookmarks -f
```

Restart after changes:

```bash
cd /opt/xtreme-bookmarks
git pull --ff-only
npm ci
npm run build
sudo systemctl restart xtreme-bookmarks
```

## Notes

The deployed app can show and manage the uploaded bookmark library from any device. Browser-session X sync depends on a logged-in desktop browser and is still best run locally unless you configure official API credentials on the server.
