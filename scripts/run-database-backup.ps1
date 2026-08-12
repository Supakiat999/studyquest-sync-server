$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security

$profileDir = Join-Path $env:LOCALAPPDATA 'StudyQuest'
$databaseSecretPath = Join-Path $profileDir 'database-url.dpapi'
$keySecretPath = Join-Path $profileDir 'database-backup-key.dpapi'
$scriptPath = Join-Path $PSScriptRoot 'database-backup.js'

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

$databaseUrl = Unprotect-StudyQuestSecret $databaseSecretPath
$backupKey = Unprotect-StudyQuestSecret $keySecretPath
try {
  $env:STUDYQUEST_BACKUP_DATABASE_URL = $databaseUrl
  $env:STUDYQUEST_BACKUP_KEY_BASE64 = $backupKey
  & node $scriptPath
  if ($LASTEXITCODE -ne 0) { throw "Database backup exited with code $LASTEXITCODE" }
}
finally {
  Remove-Item Env:STUDYQUEST_BACKUP_DATABASE_URL -ErrorAction SilentlyContinue
  Remove-Item Env:STUDYQUEST_BACKUP_KEY_BASE64 -ErrorAction SilentlyContinue
  $databaseUrl = $null
  $backupKey = $null
}
