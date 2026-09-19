# Private Linux deployment

Run one application process with its own Unix account and data directory.
Use Node.js 20 or later. Build with `npm ci && npm run release:check`.
Install the application under `/opt/xtreme-bookmarks`, owned by root; the
service account should not be able to rewrite executable code.

The supplied service expects a private `/etc/xtreme-bookmarks/service.env`:

```dotenv
HOME=/var/lib/xtreme-bookmarks
XTREME_BOOKMARKS_DATA_DIR=/var/lib/xtreme-bookmarks/data
XTREME_BOOKMARKS_NO_OPEN=1
XTREME_BOOKMARKS_WEB_HOST=127.0.0.1
XB_WEB_USER=xtreme
XB_WEB_PASSWORD=GENERATE_A_LONG_RANDOM_PASSWORD
XB_CORS_ORIGINS=https://YOUR_HOSTNAME
FT_BROWSER=chrome
```

Generate a unique password locally on the server; never commit it. Make the
environment file root-only. The data directory belongs to `xtreme-bookmarks`
and must have mode 700. Restore the complete active archive (including Markdown,
ideas, preferences, and provider configuration when present), not only the DB.
Keep the original source untouched. Do not copy obsolete conflict snapshots.

Use an HTTPS reverse proxy with authentication on **every** route, including
health checks. For Apache, use `ProxyPreserveHost Off`: the application validates
loopback Host headers. Set the one public origin explicitly as above. Forward
Authorization to the app and use matching credentials at both layers. Disable
proxying of the ACME challenge path. Never expose port 3848 publicly.
Install `renew-certificate.sh` under `/etc/letsencrypt/renewal-hooks/deploy/`
with mode 755 so Apache loads the renewed certificate after Certbot succeeds.

Backups: install `backup.sh` as `/usr/local/sbin/xtreme-bookmarks-backup` and the
units under `/etc/systemd/system`. Enable the application and backup timer.
The backup pauses only this app, captures data and configuration, verifies the
archive, and restarts the app even on failure. Archives contain credentials and
must remain private. Retention is seven days; copy backups securely off-host for
protection against server loss. Test a restore before relying on backups.

Recovery: stop the app, preserve the current data directory, extract a verified
backup into a separate private staging directory, check SQLite integrity and
record counts, restore data and configuration with the correct owners, and
start the app. Do not overwrite a running database.

Browser-session sync can use a securely transferred session cache until X
invalidates it or it expires. A cloud server cannot read a laptop browser.
For a dedicated server, `XB_X_SESSION_FILE` can point to a private JSON file
containing `csrfToken` and `cookieHeader`, provisioned from your own authorized
X session. Protect it with mode 600 and service-account ownership. This is an
explicit credential, not an automatically refreshed browser cache: X validates
it on every request and can revoke it at any time. Replace it securely after
reauthentication when X rejects it. Never put it in Git or a public web directory.
Reconnect X authentication when needed. Ask requires its own configured model
engine; copying the bookmark database does not install or authenticate one.
Without an engine, the app can return local evidence but not model synthesis.

Before opening the link: verify unauthenticated requests return 401, authenticated
search works, the certificate is valid, the application listens only on loopback,
the migrated record counts match, and pre-existing websites still respond.
