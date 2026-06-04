$ErrorActionPreference = "Stop"

$ProjectDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Port = 3847
$Url = "http://localhost:$Port/"
$OutLog = Join-Path $ProjectDir "web-server-3847.out.log"
$ErrLog = Join-Path $ProjectDir "web-server-3847.err.log"

function Test-XtremeBookmarks {
  try {
    $response = Invoke-WebRequest -UseBasicParsing $Url -TimeoutSec 3
    return ($response.StatusCode -eq 200 -and $response.Content -match "Xtreme Bookmarks")
  } catch {
    return $false
  }
}

if (-not (Test-XtremeBookmarks)) {
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
