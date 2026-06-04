param(
  [string]$EnvPath = ".env.local"
)

$ErrorActionPreference = "Stop"

function Read-SecretText {
  param([string]$Prompt)
  $secure = Read-Host $Prompt -AsSecureString
  if ($secure.Length -eq 0) { return $null }
  $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try {
    return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
  }
}

function Set-EnvValue {
  param(
    [string[]]$Lines,
    [string]$Name,
    [string]$Value
  )
  if ([string]::IsNullOrWhiteSpace($Value)) { return $Lines }

  $pattern = "^\s*$([Regex]::Escape($Name))="
  $updated = $false
  $next = foreach ($line in $Lines) {
    if ($line -match $pattern) {
      $updated = $true
      "$Name=$Value"
    } else {
      $line
    }
  }
  if (-not $updated) {
    $next += "$Name=$Value"
  }
  return $next
}

$resolved = Join-Path (Get-Location) $EnvPath
if (Test-Path $resolved) {
  $lines = @(Get-Content $resolved)
} else {
  $lines = @()
}

Write-Host ""
Write-Host "Paste each value from X. Input is hidden. Leave blank to keep the existing value."
Write-Host ""

$consumerKey = Read-SecretText "Consumer Key -> X_API_KEY"
$secretKey = Read-SecretText "Secret Key -> X_API_SECRET"
$bearerToken = Read-SecretText "Bearer Token -> X_BEARER_TOKEN"

$lines = Set-EnvValue $lines "X_API_KEY" $consumerKey
$lines = Set-EnvValue $lines "X_API_SECRET" $secretKey
$lines = Set-EnvValue $lines "X_BEARER_TOKEN" $bearerToken

Set-Content -LiteralPath $resolved -Value $lines -Encoding UTF8

Write-Host ""
Write-Host "Saved credentials to $resolved. Values were not printed."
Write-Host "Press Enter to close."
[void](Read-Host)
