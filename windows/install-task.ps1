# install-task.ps1 — register a scheduled task that runs start.ps1 when THIS user logs on.
# It does not run before a logon: a reboot with nobody logged on leaves the host down.
param([Parameter(Mandatory=$true)][string]$Mcp, [string]$Name = 'Lyra', [string]$Model = 'qwen3:8b', [string]$Topic = 'council', [string]$Operator = '')
$start = Join-Path $PSScriptRoot 'start.ps1'
$arg = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$start`" -Mcp `"$Mcp`" -Name `"$Name`" -Model `"$Model`" -Topic `"$Topic`" -Operator `"$Operator`""
$action  = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $arg
$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$trigger.Delay = 'PT90S'                                   # let the network and Ollama come up first
$set = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
Register-ScheduledTask -TaskName "axona-model-host-$Name" -Action $action -Trigger $trigger -Settings $set -Force | Out-Null
"registered task axona-model-host-$Name (at logon of $env:USERNAME, 90 s delay)"
