$ErrorActionPreference = "Stop"

$ProjectDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Port = 3847
$Url = "http://localhost:$Port/"
$StatsUrl = "http://localhost:$Port/api/stats"
$OutLog = Join-Path $ProjectDir "web-server-3847.out.log"
$ErrLog = Join-Path $ProjectDir "web-server-3847.err.log"

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
  foreach ($listener in $listeners) {
    try {
      $proc = Get-CimInstance Win32_Process -Filter "ProcessId = $($listener.OwningProcess)"
      if ($proc.CommandLine -match "xtreme-bookmarks" -or $proc.CommandLine -match "bin/ft\.mjs web") {
        Stop-Process -Id $listener.OwningProcess -Force -ErrorAction SilentlyContinue
      }
    } catch {}
  }

  $env:XTREME_BOOKMARKS_NO_OPEN = "1"
  Start-Process `
    -FilePath "node" `
    -ArgumentList @("bin/ft.mjs", "web", "--port", "$Port") `
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
