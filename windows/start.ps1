# start.ps1 — start Ollama if it is not serving, then start the host DETACHED.
# A process started inside an ssh session dies with the session; Win32_Process Create does not.
param(
  [Parameter(Mandatory=$true)][string]$Mcp,          # path to the Axona MCP server script (…\axona-relay\src\mcp.js)
  [string]$Name  = 'Lyra',
  [string]$Model = 'qwen3:8b',
  [string]$Topic = 'council',
  [string]$Operator = '',
  [string]$Trusted = '',       # comma list of signer prefixes answered on any mention
  [string]$Since = '',         # ISO time: answer posts from then on, once
  [string]$RunnerSigner = '',  # full 64-hex signer of the test runner; empty = run_alert_bot_test is not offered
  [string]$Night = '',         # local hours "HH-HH" in which the host starts tests by itself, e.g. 22-06; empty = never
  [string]$NightGapMs = ''     # least time between two night run starts (default 300000)
)
$ErrorActionPreference = 'Stop'
$repo  = Split-Path -Parent $PSScriptRoot
$slug  = ($Name.ToLower() -replace '[^a-z0-9]+','-')
$dir   = Join-Path $env:USERPROFILE '.axona'
$node  = (Get-Command node).Source
$ollama = Join-Path $env:LOCALAPPDATA 'Programs\Ollama\ollama.exe'
if (-not (Test-Path $Mcp)) { "MCP server script not found: $Mcp"; exit 2 }

$running = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*axona-model-host*host.mjs*' -and $_.CommandLine -like "*council*" }
if ($running) { "already running pid=$($running.ProcessId -join ',')"; exit 0 }

$up = $false; try { $null = Invoke-RestMethod http://127.0.0.1:11434/api/version -TimeoutSec 3; $up = $true } catch {}
if (-not $up) {
  $null = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = "`"$ollama`" serve" }
  for ($i = 0; $i -lt 20 -and -not $up; $i++) { Start-Sleep 2; try { $null = Invoke-RestMethod http://127.0.0.1:11434/api/version -TimeoutSec 3; $up = $true } catch {} }
  if (-not $up) { 'Ollama did not start'; exit 3 }
}
Remove-Item (Join-Path $dir "$slug.stop") -ErrorAction SilentlyContinue

# The settings travel in a small launcher so the detached process needs no inherited environment.
$launch = Join-Path $dir "$slug-launch.cmd"
New-Item -ItemType Directory -Force $dir | Out-Null
@"
@echo off
set AXONA_MCP=$Mcp
set HOST_NAME=$Name
set HOST_MODEL=$Model
set HOST_TOPIC=$Topic
set HOST_OPERATOR=$Operator
set HOST_TRUSTED=$Trusted
set HOST_SINCE=$Since
set HOST_RUNNER_SIGNER=$RunnerSigner
set HOST_NIGHT=$Night
set HOST_NIGHT_GAP_MS=$NightGapMs
"$node" "$repo\src\host.mjs" council
"@ | Set-Content -Encoding ASCII $launch
$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = "cmd.exe /c `"$launch`""; CurrentDirectory = $repo }
"started rc=$($r.ReturnValue) pid=$($r.ProcessId) name=$Name model=$Model topic=$Topic runner=$(if($RunnerSigner){$RunnerSigner.Substring(0,12)}else{'none'}) night=$(if($Night){$Night}else{'off'})"
