param(
  [Parameter(Mandatory = $true)][string]$Domain,
  [Parameter(Mandatory = $true)][string]$Email,
  [string]$Commit = "",
  [string]$DataDir = "",
  [switch]$SkipDataUpload,
  [string]$InstanceName = "xtreme-bookmarks",
  [string]$Region = "us-west-2",
  [string]$AvailabilityZone = "us-west-2a",
  [string]$BlueprintId = "ubuntu_24_04",
  [string]$BundleId = "micro_3_0",
  [string]$StaticIpName = "xtreme-bookmarks-ip",
  [string]$WebUser = "xtreme"
)

$ErrorActionPreference = "Stop"
$Bash = Get-Command bash -ErrorAction SilentlyContinue
if (-not $Bash) {
  throw "bash is required. Install Git for Windows/WSL, or run scripts/deploy-lightsail.sh from macOS or Linux."
}
if (-not $env:XTREME_BOOKMARKS_WEB_PASSWORD) {
  throw "Set XTREME_BOOKMARKS_WEB_PASSWORD before deploying."
}

$ProjectDir = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$Script = Join-Path $ProjectDir "scripts/deploy-lightsail.sh"
$Arguments = @(
  $Script,
  "--domain", $Domain,
  "--email", $Email,
  "--instance-name", $InstanceName,
  "--region", $Region,
  "--availability-zone", $AvailabilityZone,
  "--blueprint-id", $BlueprintId,
  "--bundle-id", $BundleId,
  "--static-ip-name", $StaticIpName,
  "--web-user", $WebUser
)
if ($Commit) { $Arguments += @("--commit", $Commit) }
if ($DataDir) { $Arguments += @("--data-dir", $DataDir) }
if ($SkipDataUpload) { $Arguments += "--skip-data-upload" }

& $Bash.Source @Arguments
if ($LASTEXITCODE -ne 0) {
  throw "Lightsail deployment failed with exit code $LASTEXITCODE."
}
