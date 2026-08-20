[CmdletBinding()]
param(
  [Parameter(Mandatory)]
  [string]$BrowserExportPath,
  [Parameter(Mandatory)]
  [string]$CloudExportPath,
  [string]$AuditPath,
  [switch]$DatabaseBackupValidated
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$profileDir = Join-Path $env:LOCALAPPDATA 'StudyQuest'
$auditDir = Join-Path $profileDir 'incident-audits'
$manifestPath = Join-Path $profileDir 'v15-release-safety.json'

if (-not $AuditPath) {
  $AuditPath = Get-ChildItem -LiteralPath $auditDir -Filter 'before-*.json' -File |
    Sort-Object LastWriteTimeUtc -Descending |
    Select-Object -First 1 -ExpandProperty FullName
}
if (-not $AuditPath -or -not (Test-Path -LiteralPath $AuditPath -PathType Leaf)) { throw 'A current before-release audit is required.' }
if (-not (Test-Path -LiteralPath $BrowserExportPath -PathType Leaf)) { throw "Browser/device export is missing: $BrowserExportPath" }
if (-not (Test-Path -LiteralPath $CloudExportPath -PathType Leaf)) { throw "Cloud export is missing: $CloudExportPath" }
if (-not $DatabaseBackupValidated) { throw 'Database backup validation must be explicitly confirmed.' }

$audit = Get-Content -LiteralPath $AuditPath -Raw | ConvertFrom-Json
$accounts = @($audit.accounts)
if ($accounts.Count -lt 1) { throw 'The audit does not contain account baselines.' }
$admin = $accounts | Where-Object { ([string]$_.username).ToLowerInvariant() -eq 'admin' } | Select-Object -First 1
if (-not $admin) { throw 'The audit does not contain the admin baseline.' }

$manifest = [ordered]@{
  version = 2
  recordedAt = (Get-Date).ToUniversalTime().ToString('o')
  adminRecoveryConflict = $false
  cloudBackupPending = $false
  browserExportPath = [IO.Path]::GetFullPath($BrowserExportPath)
  cloudExportPath = [IO.Path]::GetFullPath($CloudExportPath)
  databaseBackupValidated = $true
  adminRevision = [int64]$admin.revision
  adminStateHash = [string]$admin.stateHash
  adminSummary = $admin.summary
  accounts = @($accounts | ForEach-Object {
    [ordered]@{
      username = ([string]$_.username).ToLowerInvariant()
      revision = [int64]$_.revision
      stateHash = [string]$_.stateHash
      summary = $_.summary
    }
  })
  v13Hash = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $repo 'public\claudever13.html')).Hash.ToLowerInvariant()
  v14Hash = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $repo 'public\claudever14.html')).Hash.ToLowerInvariant()
  v15Hash = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $repo 'public\claudever15.html')).Hash.ToLowerInvariant()
}

[IO.Directory]::CreateDirectory($profileDir) | Out-Null
$temporary = "$manifestPath.$PID.$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()).tmp"
[IO.File]::WriteAllText($temporary, ($manifest | ConvertTo-Json -Depth 12), (New-Object Text.UTF8Encoding($false)))
Move-Item -LiteralPath $temporary -Destination $manifestPath -Force
Write-Output $manifestPath
