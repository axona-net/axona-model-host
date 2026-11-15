# status.ps1 — is the host running, is Ollama serving, and the last lines of the log (connection chatter left out).
param([string]$Name = 'Lyra', [int]$Lines = 8)
$slug = ($Name.ToLower() -replace '[^a-z0-9]+','-')
$p = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*axona-model-host*host.mjs*' }
"host: $(if ($p) { 'running pid=' + ($p.ProcessId -join ',') } else { 'NOT running' })"
try { $v = Invoke-RestMethod http://127.0.0.1:11434/api/version -TimeoutSec 3; "ollama: serving $($v.version)" } catch { 'ollama: NOT serving' }
$log = Join-Path $env:USERPROFILE ".axona\$slug-host-council.jsonl"
if (Test-Path $log) { Get-Content $log -Tail 200 | Select-Object -Last $Lines | ForEach-Object { $_.Substring(0, [math]::Min(400, $_.Length)) } } else { 'no log yet' }
