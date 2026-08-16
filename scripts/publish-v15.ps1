[CmdletBinding()]
param(
  [switch]$DryRun,
  [string]$ReleaseRepo,
  [string]$SafetyManifest,
  [string]$LiveOrigin = 'https://studyquest-sync-server.onrender.com'
)

$ErrorActionPreference = 'Stop'
$workspace = Split-Path -Parent $PSScriptRoot
if (-not $ReleaseRepo) { $ReleaseRepo = $workspace }
$ReleaseRepo = [IO.Path]::GetFullPath($ReleaseRepo)
$releaseRepoSafeDirectory = $ReleaseRepo.Replace('\', '/')
$profileDir = Join-Path $env:LOCALAPPDATA 'StudyQuest'
if (-not $SafetyManifest) { $SafetyManifest = Join-Path $profileDir 'v15-release-safety.json' }
$evidenceDir = Join-Path $profileDir 'v15-release-evidence'
$lockFile = Join-Path $workspace '..\studyquest-v15-release.lock'
$sourceHtml = Join-Path $ReleaseRepo 'public\claudever15.html'
$versionFile = Join-Path $ReleaseRepo 'public\v15-version.json'
$checker = Join-Path $ReleaseRepo 'scripts\check-v15-release.js'
$backupRunner = Join-Path $ReleaseRepo 'scripts\run-database-backup.ps1'
$expectedFiles = @(
  'public/claudever15.html',
  'public/v15-version.json',
  'scripts/check-v15-release.js',
  'scripts/test-v15-release.js',
  'scripts/publish-v15.ps1',
  'STUDYQUEST-OPERATIONS-GUIDE.md'
)
$startedAt = (Get-Date).ToUniversalTime().ToString('o')
$lock = $null
$commit = ''
$sourceHash = ''
$backupResult = $null
$gate = $null
$previousGitConfigCount = $env:GIT_CONFIG_COUNT
$previousGitConfigKey0 = $env:GIT_CONFIG_KEY_0
$previousGitConfigValue0 = $env:GIT_CONFIG_VALUE_0

function Write-Utf8NoBom {
  param([string]$Path, [string]$Content)
  [IO.File]::WriteAllText($Path, $Content, (New-Object Text.UTF8Encoding($false)))
}

function Write-Evidence {
  param([string]$Status, [string]$Message)
  try {
    New-Item -ItemType Directory -Path $evidenceDir -Force | Out-Null
    $stamp = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH-mm-ssZ')
    $path = Join-Path $evidenceDir "v15-$stamp.json"
    $payload = [ordered]@{
      status = $Status
      message = $Message
      startedAt = $startedAt
      finishedAt = (Get-Date).ToUniversalTime().ToString('o')
      dryRun = [bool]$DryRun
      sourceHash = $sourceHash
      commit = $commit
      safetyManifest = $SafetyManifest
      databaseBackup = $backupResult
      gate = $gate
    } | ConvertTo-Json -Depth 12
    Write-Utf8NoBom -Path $path -Content $payload
    Write-Output "Safety evidence: $path"
  } catch {
    Write-Warning "Could not write safety evidence: $($_.Exception.Message)"
  }
}

function Assert-OutsideReleaseRepo {
  param([string]$Path, [string]$Label)
  $resolved = [IO.Path]::GetFullPath($Path)
  if ($resolved.StartsWith($ReleaseRepo, [StringComparison]::OrdinalIgnoreCase)) {
    throw "$Label must be outside the release checkout: $resolved"
  }
  if (-not (Test-Path -LiteralPath $resolved -PathType Leaf)) {
    throw "$Label is missing: $resolved"
  }
  return $resolved
}

function Read-SafetyManifest {
  if (-not (Test-Path -LiteralPath $SafetyManifest -PathType Leaf)) {
    throw "Safety manifest is required: $SafetyManifest"
  }
  $value = Get-Content -LiteralPath $SafetyManifest -Raw | ConvertFrom-Json
  if ($value.version -ne 1) { throw 'Safety manifest version must be 1.' }
  if ($value.adminRecoveryConflict -ne $false) { throw 'Recovery Center conflict gate is not clear.' }
  if ($value.cloudBackupPending -ne $false) { throw 'Cloud backup pending gate is not clear.' }
  if (-not $value.recordedAt) { throw 'Safety manifest recordedAt is required.' }
  $recordedAt = [DateTimeOffset]::Parse([string]$value.recordedAt)
  $age = [DateTimeOffset]::UtcNow - $recordedAt.ToUniversalTime()
  if ($age.TotalMinutes -lt 0 -or $age.TotalHours -gt 24) { throw 'Safety manifest is older than 24 hours.' }
  [void](Assert-OutsideReleaseRepo ([string]$value.browserExportPath) 'Browser/device export')
  [void](Assert-OutsideReleaseRepo ([string]$value.cloudExportPath) 'Cloud export')
  if ($value.databaseBackupValidated -ne $true) { throw 'Database backup validation is not recorded as successful.' }
  $revision = 0L
  if (-not [int64]::TryParse([string]$value.adminRevision, [ref]$revision)) { throw 'Admin revision is required.' }
  if ([string]$value.adminStateHash -notmatch '^[a-f0-9]{64}$') { throw 'Admin state hash is invalid.' }
  if ([string]$value.v13Hash -ne '9667d4c65548327c25ced9f161edea902e398f94b59941e27c3b576b37dab4e7') { throw 'Recorded v13 hash does not match the protected release.' }
  $expectedV14 = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $ReleaseRepo 'public\claudever14.html')).Hash.ToLowerInvariant()
  if ([string]$value.v14Hash -ne $expectedV14) { throw 'Recorded v14 hash does not match the release checkout.' }
  return $value
}

function Invoke-CheckedCommand {
  param([string]$FilePath, [string[]]$Arguments, [string]$FailureMessage)
  $previousErrorAction = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    $output = & $FilePath @Arguments 2>&1
    $exitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousErrorAction
  }
  if ($exitCode -ne 0) { throw $FailureMessage }
  return ($output | Out-String).Trim()
}

function Run-DatabaseBackup {
  $output = Invoke-CheckedCommand 'powershell.exe' @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $backupRunner) 'Encrypted database backup failed.'
  $jsonLine = ($output -split "`r?`n" | Where-Object { $_.Trim().StartsWith('{') } | Select-Object -Last 1)
  if (-not $jsonLine) { throw 'Encrypted database backup did not return validation output.' }
  $result = $jsonLine | ConvertFrom-Json
  if ($result.ok -ne $true -or $result.validated -ne $true) { throw 'Encrypted database backup was not validated.' }
  return $result
}

function Get-WorkingPaths {
  return @(& git status --porcelain=v1 --untracked-files=all | ForEach-Object {
    if ($_.Length -ge 4) { $_.Substring(3).Trim() }
  } | Where-Object { $_ })
}

function Assert-OnlyExpectedWorkingChanges {
  param([string]$Context)
  $paths = Get-WorkingPaths
  $unexpected = @($paths | Where-Object { $_ -notin $expectedFiles })
  if ($unexpected.Count -gt 0) {
    throw "$Context contains unexpected files: $($unexpected -join ', ')"
  }
  $stagedUnexpected = @(& git diff --cached --name-only | Where-Object { $_ -notin $expectedFiles })
  if ($stagedUnexpected.Count -gt 0) {
    throw "$Context has unexpected staged files: $($stagedUnexpected -join ', ')"
  }
}

try {
  $env:GIT_CONFIG_COUNT = '1'
  $env:GIT_CONFIG_KEY_0 = 'safe.directory'
  $env:GIT_CONFIG_VALUE_0 = $releaseRepoSafeDirectory
  $lock = [IO.File]::Open($lockFile, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
  if (-not (Test-Path -LiteralPath (Join-Path $ReleaseRepo '.git'))) { throw "Release checkout is missing: $ReleaseRepo" }
  if (-not (Test-Path -LiteralPath $sourceHtml -PathType Leaf)) { throw "v15 HTML is missing: $sourceHtml" }
  if (-not (Test-Path -LiteralPath $versionFile -PathType Leaf)) { throw "v15 metadata is missing: $versionFile" }
  if (-not (Test-Path -LiteralPath $checker -PathType Leaf)) { throw "v15 checker is missing: $checker" }
  if (-not (Test-Path -LiteralPath $backupRunner -PathType Leaf)) { throw "Database backup runner is missing: $backupRunner" }

  $gate = Read-SafetyManifest
  $sourceHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $sourceHtml).Hash.ToLowerInvariant()
  $version = Get-Content -LiteralPath $versionFile -Raw | ConvertFrom-Json
  if ($version.version -ne 15 -or [string]$version.hash -ne $sourceHash) { throw 'v15 version metadata does not match the HTML hash.' }

  Push-Location $ReleaseRepo
  try {
    Assert-OnlyExpectedWorkingChanges 'Release checkout'
    Invoke-CheckedCommand 'git' @('fetch', 'origin', 'main') 'Could not fetch origin/main.' | Out-Null
    $remoteMain = (& git rev-parse origin/main).Trim()
    $head = (& git rev-parse HEAD).Trim()
    & git merge-base --is-ancestor origin/main HEAD
    if ($LASTEXITCODE -ne 0) { throw 'Release HEAD is not a fast-forward descendant of origin/main.' }

    Invoke-CheckedCommand 'npm.cmd' @('run', 'check') 'Complete hosted release checks failed.' | Out-Null
    $backupResult = Run-DatabaseBackup

    if ($DryRun) {
      Write-Evidence 'checked' 'Safety gate, database backup, Git ancestry, and full release checks passed. Nothing was committed or pushed.'
      Write-Output "v15 dry run passed: $sourceHash"
      exit 0
    }

    $auth = & gh auth status -h github.com 2>&1
    if ($LASTEXITCODE -ne 0) { throw 'GitHub authentication is not ready. Run gh auth login -h github.com --web.' }
    Assert-OnlyExpectedWorkingChanges 'Release checkout after checks'

    & git add -- public/claudever15.html public/v15-version.json scripts/check-v15-release.js scripts/test-v15-release.js scripts/publish-v15.ps1 STUDYQUEST-OPERATIONS-GUIDE.md
    if ($LASTEXITCODE -ne 0) { throw 'Could not stage the v15 release files.' }
    $staged = @(& git diff --cached --name-only)
    $unexpected = @($staged | Where-Object { $_ -notin $expectedFiles })
    if ($unexpected.Count -gt 0) { throw "Publisher staged unexpected files: $($unexpected -join ', ')" }
    if ($staged.Count -eq 0) { throw 'No v15 release changes are staged.' }

    $message = "chore(v15): release safe admin pilot $((Get-Date).ToString('yyyy-MM-dd HH:mm')) ICT"
    & git commit -m $message
    if ($LASTEXITCODE -ne 0) { throw 'Could not commit the v15 release.' }
    $commit = (& git rev-parse HEAD).Trim()
    Invoke-CheckedCommand 'git' @('fetch', 'origin', 'main') 'Could not refresh origin/main before push.' | Out-Null
    if ((& git rev-parse origin/main).Trim() -ne $remoteMain) { throw 'origin/main advanced during the release; refusing to push.' }
    & git merge-base --is-ancestor origin/main HEAD
    if ($LASTEXITCODE -ne 0) { throw 'The release is no longer a fast-forward from origin/main.' }
    & git push origin 'HEAD:main'
    if ($LASTEXITCODE -ne 0) { throw 'Could not push the v15 release to origin/main.' }

    $deadline = (Get-Date).AddMinutes(15)
    $deployed = $false
    while ((Get-Date) -lt $deadline) {
      try {
        $versionLive = Invoke-RestMethod -Uri "$LiveOrigin/api/version?version=15" -Method Get -TimeoutSec 75
        $health = Invoke-RestMethod -Uri "$LiveOrigin/api/health" -Method Get -TimeoutSec 75
        $v13Live = Invoke-RestMethod -Uri "$LiveOrigin/api/version?version=13" -Method Get -TimeoutSec 75
        $v14Live = Invoke-RestMethod -Uri "$LiveOrigin/api/version?version=14" -Method Get -TimeoutSec 75
        if ($health.ok -and [string]$versionLive.hash -eq $sourceHash -and [string]$v13Live.hash -eq [string]$gate.v13Hash -and [string]$v14Live.hash -eq [string]$gate.v14Hash) {
          $deployed = $true
          break
        }
      } catch {}
      Start-Sleep -Seconds 20
    }
    if (-not $deployed) { throw 'Render did not report the exact v15 hash and protected v13/v14 hashes within 15 minutes.' }
    Write-Evidence 'deployed' 'v15 code is live on Render with exact hash and protected v13/v14 hashes. Runtime v15 access must be enabled separately as admin.'
    Write-Output "v15 deployed: $commit"
  } finally {
    Pop-Location
  }
} catch {
  Write-Evidence 'failed' $_.Exception.Message
  Write-Error $_.Exception.Message
  exit 1
} finally {
  if ($lock) { $lock.Dispose() }
  Remove-Item -LiteralPath $lockFile -Force -ErrorAction SilentlyContinue
  if ($null -eq $previousGitConfigCount) { Remove-Item Env:GIT_CONFIG_COUNT -ErrorAction SilentlyContinue } else { $env:GIT_CONFIG_COUNT = $previousGitConfigCount }
  if ($null -eq $previousGitConfigKey0) { Remove-Item Env:GIT_CONFIG_KEY_0 -ErrorAction SilentlyContinue } else { $env:GIT_CONFIG_KEY_0 = $previousGitConfigKey0 }
  if ($null -eq $previousGitConfigValue0) { Remove-Item Env:GIT_CONFIG_VALUE_0 -ErrorAction SilentlyContinue } else { $env:GIT_CONFIG_VALUE_0 = $previousGitConfigValue0 }
}
