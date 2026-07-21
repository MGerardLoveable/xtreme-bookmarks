param(
  [int]$Port = 3848
)

$ErrorActionPreference = "Stop"

$ProjectDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Url = "http://localhost:$Port/"
$StatsUrl = "http://localhost:$Port/api/stats"
$LogDir = Join-Path $env:LOCALAPPDATA "Xtreme Bookmarks\logs"
$Timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$OutLog = Join-Path $LogDir "web-server-$Port-$Timestamp.out.log"
$ErrLog = Join-Path $LogDir "web-server-$Port-$Timestamp.err.log"
$Launcher = Join-Path $ProjectDir "bin\xb.mjs"

function Test-XtremeBookmarks {
  try {
    $page = Invoke-WebRequest -UseBasicParsing $Url -TimeoutSec 3
    if (-not ($page.StatusCode -eq 200 -and $page.Content -match "Xtreme Bookmarks")) {
      return $false
    }

    $stats = Invoke-WebRequest -UseBasicParsing $StatsUrl -TimeoutSec 8
    return ($stats.StatusCode -eq 200 -and $stats.Content -match "totalBookmarks")
  } catch {
    return $false
  }
}

if (-not (Test-XtremeBookmarks)) {
  $listeners = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
  if ($listeners) {
    throw "Port $Port is already in use by another process. Start with a different port: .\Start-Xtreme-Bookmarks.ps1 -Port 3849"
  }

  if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw "Node.js 20 or newer is required and was not found on PATH."
  }
  if (-not (Test-Path $Launcher)) {
    throw "Xtreme Bookmarks launcher was not found: $Launcher"
  }
  if (-not (Test-Path (Join-Path $ProjectDir "dist\cli.js"))) {
    Write-Host "Building Xtreme Bookmarks..."
    & npm run build --prefix $ProjectDir
    if ($LASTEXITCODE -ne 0) { throw "Xtreme Bookmarks build failed." }
  }

  New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
  $env:XTREME_BOOKMARKS_NO_OPEN = "1"
  Start-Process `
    -FilePath "node" `
    -ArgumentList @($Launcher, "web", "--port", "$Port") `
    -WorkingDirectory $ProjectDir `
    -RedirectStandardOutput $OutLog `
    -RedirectStandardError $ErrLog `
    -WindowStyle Hidden

  $ready = $false
  for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Milliseconds 500
    if (Test-XtremeBookmarks) {
      $ready = $true
      break
    }
  }

  if (-not $ready) {
    $message = "Xtreme Bookmarks did not start on $Url. Check $ErrLog for details."
    Add-Type -AssemblyName PresentationFramework
    [System.Windows.MessageBox]::Show($message, "Xtreme Bookmarks") | Out-Null
    exit 1
  }
}

Start-Process $Url
