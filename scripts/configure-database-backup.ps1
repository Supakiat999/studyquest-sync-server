param(
  [Parameter(Mandatory = $true)]
  [string]$DatabaseUrl
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$profileDir = Join-Path $env:LOCALAPPDATA 'StudyQuest'
$databaseSecretPath = Join-Path $profileDir 'database-url.dpapi'
$keySecretPath = Join-Path $profileDir 'database-backup-key.dpapi'

function Protect-StudyQuestSecret([string]$Value, [string]$Path) {
  $clear = [Text.Encoding]::UTF8.GetBytes($Value)
  try {
    $protected = [System.Security.Cryptography.ProtectedData]::Protect(
      $clear,
      [Text.Encoding]::UTF8.GetBytes('StudyQuest database backup v1'),
      [System.Security.Cryptography.DataProtectionScope]::CurrentUser
    )
    [IO.File]::WriteAllText($Path, [Convert]::ToBase64String($protected), [Text.UTF8Encoding]::new($false))
  }
  finally { [Array]::Clear($clear, 0, $clear.Length) }
}

if ($DatabaseUrl -notmatch '^postgres(?:ql)?://') { throw 'DatabaseUrl must be a PostgreSQL connection string.' }
[IO.Directory]::CreateDirectory($profileDir) | Out-Null
Protect-StudyQuestSecret $DatabaseUrl $databaseSecretPath
if (-not (Test-Path -LiteralPath $keySecretPath)) {
  $key = [byte[]]::new(32)
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try {
    $rng.GetBytes($key)
    Protect-StudyQuestSecret ([Convert]::ToBase64String($key)) $keySecretPath
  }
  finally {
    $rng.Dispose()
    [Array]::Clear($key, 0, $key.Length)
  }
}

& icacls.exe $profileDir /inheritance:r /grant:r "${env:USERNAME}:(OI)(CI)F" | Out-Null
Write-Output 'StudyQuest database backup secrets are protected for the current Windows user.'
