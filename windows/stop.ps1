# stop.ps1 — ask the host to stop by its stop file and wait for it to leave. Ollama is left running.
param([string]$Name = 'Lyra')
$slug = ($Name.ToLower() -replace '[^a-z0-9]+','-')
New-Item -ItemType File -Force (Join-Path $env:USERPROFILE ".axona\$slug.stop") | Out-Null
for ($i = 0; $i -lt 45; $i++) {
  $p = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*axona-model-host*host.mjs*' }
  if (-not $p) { "stopped after $($i*2)s"; exit 0 }
  Start-Sleep 2
}
"STILL RUNNING pid=$($p.ProcessId -join ',')"; exit 1
