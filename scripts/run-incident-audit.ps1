param(
  [ValidateSet('before', 'after')]
  [string]$Phase = 'before'
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security

$profileDir = Join-Path $env:LOCALAPPDATA 'StudyQuest'
$databaseSecretPath = Join-Path $profileDir 'database-url.dpapi'
$scriptPath = Join-Path $PSScriptRoot 'incident-audit.js'
$protected = [Convert]::FromBase64String((Get-Content -LiteralPath $databaseSecretPath -Raw).Trim())
$clear = [System.Security.Cryptography.ProtectedData]::Unprotect(
  $protected,
  [Text.Encoding]::UTF8.GetBytes('StudyQuest database backup v1'),
  [System.Security.Cryptography.DataProtectionScope]::CurrentUser
)
try {
  $env:STUDYQUEST_BACKUP_DATABASE_URL = [Text.Encoding]::UTF8.GetString($clear)
  $auditDir = Join-Path $profileDir 'incident-audits'
  [IO.Directory]::CreateDirectory($auditDir) | Out-Null
  $timestamp = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH-mm-ssZ')
  $env:STUDYQUEST_INCIDENT_AUDIT_FILE = Join-Path $auditDir "$Phase-$timestamp.json"
  & node $scriptPath
  if ($LASTEXITCODE -ne 0) { throw "Incident audit exited with code $LASTEXITCODE" }
}
finally {
  Remove-Item Env:STUDYQUEST_BACKUP_DATABASE_URL -ErrorAction SilentlyContinue
  Remove-Item Env:STUDYQUEST_INCIDENT_AUDIT_FILE -ErrorAction SilentlyContinue
  [Array]::Clear($clear, 0, $clear.Length)
}
