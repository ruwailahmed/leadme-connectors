# Customer installer (Windows). Runs the connector agent at logon on THIS machine.
#   powershell -ExecutionPolicy Bypass -File install-agent.ps1 -License <key> -Url <artifact.tgz>
param(
  [Parameter(Mandatory = $true)][string]$License,
  [string]$ControlPlane = "https://leadme-connectors.vercel.app",
  [Parameter(Mandatory = $true)][string]$Url,
  [int]$Port = 4310
)
$ErrorActionPreference = "Stop"

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw "Node.js 22.18+ is required: https://nodejs.org/en/download"
}
$major = [int]((node -p "process.versions.node.split('.')[0]"))
if ($major -lt 22) { throw "Node 22.18+ required (found $(node -v))" }

$dir = Join-Path $env:LOCALAPPDATA "leadme-agent"
New-Item -ItemType Directory -Force -Path $dir | Out-Null
Write-Host "-> downloading agent"
Invoke-WebRequest -Uri $Url -OutFile (Join-Path $dir "agent.tgz")
tar -xzf (Join-Path $dir "agent.tgz") -C $dir

$key = -join ((1..64) | ForEach-Object { "0123456789abcdef"[Get-Random -Maximum 16] })
$envFile = Join-Path $dir ".env"
@"
AGENT_MODE=1
PORT=$Port
LICENSE_KEY=$License
CONTROL_PLANE_URL=$ControlPlane
CREDENTIALS_KEY=$key
"@ | Set-Content -Encoding ASCII $envFile

$node = (Get-Command node).Source
$action = New-ScheduledTaskAction -Execute $node -Argument "--env-file-if-exists=.env src/server.ts" -WorkingDirectory $dir
$trigger = New-ScheduledTaskTrigger -AtLogOn
Register-ScheduledTask -TaskName "leadme-agent" -Action $action -Trigger $trigger `
  -Description "leadme connector agent (browsers stay on this machine)" -Force | Out-Null
Start-ScheduledTask -TaskName "leadme-agent"

Write-Host ""
Write-Host "Agent:    http://localhost:$Port"
Write-Host "Licence:  paired with $ControlPlane"
Write-Host "Stop:     Stop-ScheduledTask -TaskName leadme-agent"
Write-Host "Remove:   Unregister-ScheduledTask -TaskName leadme-agent -Confirm:`$false; Remove-Item -Recurse -Force `"$dir`""
