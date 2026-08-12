$ErrorActionPreference = 'Stop'
$taskName = 'StudyQuest Encrypted Database Backup'
$profileDir = Join-Path $env:LOCALAPPDATA 'StudyQuest'
$databaseSecretPath = Join-Path $profileDir 'database-url.dpapi'
$keySecretPath = Join-Path $profileDir 'database-backup-key.dpapi'
$hiddenRunner = Join-Path $PSScriptRoot 'run-database-backup-hidden.vbs'

if (-not (Test-Path -LiteralPath $databaseSecretPath) -or -not (Test-Path -LiteralPath $keySecretPath)) {
  throw 'Configure the protected database backup secrets before installing the task.'
}

$action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "//B //Nologo `"$hiddenRunner`""
$trigger = New-ScheduledTaskTrigger -Daily -At '03:30'
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -Hidden -ExecutionTimeLimit (New-TimeSpan -Minutes 30) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description 'Encrypted StudyQuest database export; retains 30 daily and 12 monthly backups.' -Force | Out-Null
Write-Output "$taskName installed for 03:30 daily with StartWhenAvailable and hidden execution."
