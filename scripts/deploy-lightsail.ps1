param(
  [string]$InstanceName = "xtreme-bookmarks",
  [string]$Region = "us-west-2",
  [string]$AvailabilityZone = "us-west-2a",
  [string]$BlueprintId = "ubuntu_24_04",
  [string]$BundleId = "micro_3_0",
  [string]$RepositoryUrl = "https://github.com/MGerardLoveable/xtreme-bookmarks.git",
  [string]$WebUser = "xtreme",
  [string]$WebPassword = "",
  [switch]$SkipDataUpload
)

$ErrorActionPreference = "Stop"

$ProjectDir = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$DeployDir = Join-Path $ProjectDir ".deploy"
$KeyName = "$InstanceName-key"
$KeyPath = Join-Path $DeployDir "$KeyName.pem"
$DataDir = Join-Path $env:USERPROFILE ".xtreme-bookmarks"

function Require-Command($Name) {
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "$Name is required but was not found on PATH."
  }
}

function New-Password {
  $bytes = New-Object byte[] 24
  [Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
  return [Convert]::ToBase64String($bytes).TrimEnd("=")
}

function AwsJson {
  param([Parameter(ValueFromRemainingArguments = $true)][object[]]$Arguments)
  $flat = @()
  foreach ($arg in $Arguments) {
    if ($arg -is [Array]) {
      foreach ($item in $arg) { $flat += [string]$item }
    } else {
      $flat += [string]$arg
    }
  }
  $json = & aws @flat --output json
  if ($LASTEXITCODE -ne 0) { throw "aws $($flat -join ' ') failed." }
  if ([string]::IsNullOrWhiteSpace($json)) { return $null }
  return $json | ConvertFrom-Json
}

Require-Command aws
Require-Command ssh
Require-Command scp

New-Item -ItemType Directory -Force -Path $DeployDir | Out-Null

try {
  AwsJson @("sts", "get-caller-identity") | Out-Null
} catch {
  throw "AWS is not logged in. Run: aws login"
}

if (-not $WebPassword) {
  $WebPassword = New-Password
}

$existingKey = $null
try {
  $existingKey = AwsJson @("lightsail", "get-key-pair", "--region", $Region, "--key-pair-name", $KeyName)
} catch {}

if (-not (Test-Path $KeyPath)) {
  if ($existingKey) {
    throw "Lightsail key pair '$KeyName' already exists, but $KeyPath is missing. Delete/recreate the key pair or provide the PEM file at that path."
  }
  $createdKey = AwsJson @("lightsail", "create-key-pair", "--region", $Region, "--key-pair-name", $KeyName)
  [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($createdKey.privateKeyBase64)) | Set-Content -NoNewline -Path $KeyPath
  icacls $KeyPath /inheritance:r /grant:r "$env:USERNAME`:R" | Out-Null
}

$envContent = @"
XTREME_BOOKMARKS_NO_OPEN=1
XTREME_BOOKMARKS_DATA_DIR=/opt/xtreme-bookmarks-data
XTREME_BOOKMARKS_WEB_USER=$WebUser
XTREME_BOOKMARKS_WEB_PASSWORD=$WebPassword
"@

$userData = @"
#!/usr/bin/env bash
set -euxo pipefail

apt-get update
apt-get install -y ca-certificates curl git nginx

curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs

mkdir -p /opt/xtreme-bookmarks /opt/xtreme-bookmarks-data
chown -R ubuntu:ubuntu /opt/xtreme-bookmarks /opt/xtreme-bookmarks-data

if [ ! -d /opt/xtreme-bookmarks/.git ]; then
  sudo -u ubuntu git clone $RepositoryUrl /opt/xtreme-bookmarks
else
  cd /opt/xtreme-bookmarks
  sudo -u ubuntu git fetch origin main
  sudo -u ubuntu git reset --hard origin/main
fi

cd /opt/xtreme-bookmarks
sudo -u ubuntu npm ci
sudo -u ubuntu npm run build

cat >/etc/xtreme-bookmarks.env <<'EOF'
$envContent
EOF
chmod 600 /etc/xtreme-bookmarks.env

cat >/etc/systemd/system/xtreme-bookmarks.service <<'EOF'
[Unit]
Description=Xtreme Bookmarks
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/opt/xtreme-bookmarks
EnvironmentFile=/etc/xtreme-bookmarks.env
ExecStart=/usr/bin/node /opt/xtreme-bookmarks/bin/ft.mjs web --port 3847
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

cat >/etc/nginx/sites-available/xtreme-bookmarks <<'EOF'
server {
  listen 80 default_server;
  listen [::]:80 default_server;
  server_name _;

  location / {
    proxy_pass http://127.0.0.1:3847;
    proxy_http_version 1.1;
    proxy_set_header Host `$host;
    proxy_set_header X-Real-IP `$remote_addr;
    proxy_set_header X-Forwarded-For `$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto `$scheme;
  }
}
EOF

rm -f /etc/nginx/sites-enabled/default
ln -sf /etc/nginx/sites-available/xtreme-bookmarks /etc/nginx/sites-enabled/xtreme-bookmarks
nginx -t
systemctl enable nginx
systemctl restart nginx
systemctl daemon-reload
systemctl enable xtreme-bookmarks
systemctl restart xtreme-bookmarks || true
"@

$userDataPath = Join-Path $DeployDir "lightsail-user-data.sh"
$userData | Set-Content -Path $userDataPath -Encoding UTF8

$instance = $null
try {
  $instance = AwsJson @("lightsail", "get-instance", "--region", $Region, "--instance-name", $InstanceName)
} catch {}

if (-not $instance) {
  AwsJson @(
    "lightsail", "create-instances",
    "--region", $Region,
    "--instance-names", $InstanceName,
    "--availability-zone", $AvailabilityZone,
    "--blueprint-id", $BlueprintId,
    "--bundle-id", $BundleId,
    "--key-pair-name", $KeyName,
    "--user-data", $userData
  ) | Out-Null
}

foreach ($port in @(80, 443)) {
  try {
    AwsJson @("lightsail", "open-instance-public-ports", "--region", $Region, "--instance-name", $InstanceName, "--port-info", "fromPort=$port,toPort=$port,protocol=TCP") | Out-Null
  } catch {}
}

Write-Host "Waiting for Lightsail public IP..."
$PublicIp = ""
for ($i = 0; $i -lt 60; $i++) {
  Start-Sleep -Seconds 10
  $instance = AwsJson @("lightsail", "get-instance", "--region", $Region, "--instance-name", $InstanceName)
  $PublicIp = [string]$instance.instance.publicIpAddress
  if ($PublicIp) { break }
}
if (-not $PublicIp) { throw "Instance did not receive a public IP in time." }

Write-Host "Waiting for SSH..."
for ($i = 0; $i -lt 60; $i++) {
  ssh -o StrictHostKeyChecking=accept-new -o ConnectTimeout=5 -i $KeyPath "ubuntu@$PublicIp" "echo ready" 2>$null
  if ($LASTEXITCODE -eq 0) { break }
  Start-Sleep -Seconds 10
}

if (-not $SkipDataUpload) {
  if (-not (Test-Path $DataDir)) {
    throw "Local data directory not found: $DataDir"
  }
  Write-Host "Uploading local Xtreme Bookmarks data..."
  ssh -i $KeyPath "ubuntu@$PublicIp" "sudo mkdir -p /opt/xtreme-bookmarks-data && sudo chown -R ubuntu:ubuntu /opt/xtreme-bookmarks-data"
  scp -i $KeyPath -r "$DataDir\*" "ubuntu@${PublicIp}:/opt/xtreme-bookmarks-data/"
  ssh -i $KeyPath "ubuntu@$PublicIp" "sudo systemctl restart xtreme-bookmarks && sudo systemctl --no-pager --full status xtreme-bookmarks | head -40"
}

$summaryPath = Join-Path $DeployDir "lightsail-summary.json"
@{
  instanceName = $InstanceName
  region = $Region
  publicIp = $PublicIp
  url = "http://$PublicIp/"
  webUser = $WebUser
  webPassword = $WebPassword
  keyPath = $KeyPath
} | ConvertTo-Json | Set-Content -Path $summaryPath

Write-Host ""
Write-Host "Xtreme Bookmarks Lightsail deployment is ready:"
Write-Host "  URL:      http://$PublicIp/"
Write-Host "  User:     $WebUser"
Write-Host "  Password: $WebPassword"
Write-Host "  Summary:  $summaryPath"
