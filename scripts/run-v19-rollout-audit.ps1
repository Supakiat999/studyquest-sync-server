$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security

$profileDir = Join-Path $env:LOCALAPPDATA 'StudyQuest'
$databaseSecretPath = Join-Path $profileDir 'database-url.dpapi'
$scriptPath = Join-Path $PSScriptRoot 'audit-v19-rollout.js'
$auditDir = Join-Path $profileDir 'v19-rollout-audits'

function Unprotect-StudyQuestSecret([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { throw "Missing protected secret: $Path" }
  $protected = [Convert]::FromBase64String((Get-Content -LiteralPath $Path -Raw).Trim())
  $clear = [System.Security.Cryptography.ProtectedData]::Unprotect(
    $protected,
    [Text.Encoding]::UTF8.GetBytes('StudyQuest database backup v1'),
    [System.Security.Cryptography.DataProtectionScope]::CurrentUser
  )
  try { return [Text.Encoding]::UTF8.GetString($clear) }
  finally { [Array]::Clear($clear, 0, $clear.Length) }
}

[IO.Directory]::CreateDirectory($auditDir) | Out-Null
$databaseUrl = Unprotect-StudyQuestSecret $databaseSecretPath
$latest = Get-ChildItem -LiteralPath $auditDir -Filter '*.json' -File -ErrorAction SilentlyContinue |
  Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
$timestamp = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH-mm-ss-fffZ')
try {
  $env:STUDYQUEST_BACKUP_DATABASE_URL = $databaseUrl
  $env:STUDYQUEST_ROLLOUT_AUDIT_FILE = Join-Path $auditDir "$timestamp.json"
  if ($latest) { $env:STUDYQUEST_ROLLOUT_PREVIOUS_FILE = $latest.FullName }
  & node $scriptPath
  if ($LASTEXITCODE -ne 0) { throw "Rollout audit exited with code $LASTEXITCODE" }
}
finally {
  Remove-Item Env:STUDYQUEST_BACKUP_DATABASE_URL -ErrorAction SilentlyContinue
  Remove-Item Env:STUDYQUEST_ROLLOUT_AUDIT_FILE -ErrorAction SilentlyContinue
  Remove-Item Env:STUDYQUEST_ROLLOUT_PREVIOUS_FILE -ErrorAction SilentlyContinue
  $databaseUrl = $null
}
