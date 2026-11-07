# setup-agent.ps1: one-time setup for Duet's normal (full-autonomy) Claude Code sessions.
# Makes a separate Windows user, "duet-agent", that cannot see Z:\ (Egnyte) or your profile, and starts
# runner.mjs as that user at every boot. Run it from an elevated PowerShell in the duet-gateway folder:
#   powershell -ExecutionPolicy Bypass -File .\setup-agent.ps1
# Run it again to update the runner or Claude Code. Add -NewClaudeToken to replace the sign-in token,
# or -Uninstall to remove the user, the task and the folder.
[CmdletBinding()]
param(
  [string]$UserName = "duet-agent",
  [string[]]$Workspaces = @("D:\Projects", "D:\Duet"),
  [string]$ClaudeExe = "$env:USERPROFILE\.local\bin\claude.exe",
  [switch]$NewClaudeToken,
  [switch]$Uninstall
)
$ErrorActionPreference = "Stop"
$me = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $me.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw "Run this from an elevated PowerShell (right-click PowerShell > Run as administrator)." }

$Repo = $PSScriptRoot
$Base = "C:\ProgramData\duet-agent"
$Task = "duet-agent-runner"
$Admins = "*S-1-5-32-544"; $System = "*S-1-5-18"
$NoBom = New-Object System.Text.UTF8Encoding $false
function Write-Text($path, $text) { [IO.File]::WriteAllText($path, $text, $NoBom) }
function New-Secret([int]$bytes) {
  $b = New-Object byte[] $bytes
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
  ([Convert]::ToBase64String($b) -replace '[+/=]', '')
}
function Step($m) { Write-Host "-> $m" -ForegroundColor Cyan }

if ($Uninstall) {
  Step "Removing task, user and $Base"
  Unregister-ScheduledTask -TaskName $Task -Confirm:$false -ErrorAction SilentlyContinue
  Get-Process node, claude -IncludeUserName -ErrorAction SilentlyContinue | Where-Object { $_.UserName -like "*\$UserName" } | Stop-Process -Force
  foreach ($w in $Workspaces) { if (Test-Path $w) { icacls $w /remove:g $UserName /T /C /Q | Out-Null } }
  Remove-LocalUser -Name $UserName -ErrorAction SilentlyContinue
  Remove-Item $Base -Recurse -Force -ErrorAction SilentlyContinue
  Write-Host "Done. C:\Users\$UserName (its profile) is left in place; delete it in System > About > Advanced > User Profiles if you want."
  return
}

$Node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $Node) { $Node = "C:\Program Files\nodejs\node.exe" }
if (-not (Test-Path $Node)) { throw "Node.js was not found." }
if (-not (Test-Path $ClaudeExe)) { throw "Claude Code was not found at $ClaudeExe. Pass -ClaudeExe <path>." }

# 1. The user. A new random password each run; only Task Scheduler keeps it.
$pw = (New-Secret 24) + "aA1!"
$sec = ConvertTo-SecureString $pw -AsPlainText -Force
if (Get-LocalUser -Name $UserName -ErrorAction SilentlyContinue) {
  Step "Updating user $UserName"
  Set-LocalUser -Name $UserName -Password $sec
} else {
  Step "Creating user $UserName (standard user, hidden from the sign-in screen)"
  New-LocalUser -Name $UserName -Password $sec -PasswordNeverExpires -UserMayNotChangePassword -AccountNeverExpires `
    -Description "Runs Claude Code sessions for Duet (duet-gateway)" | Out-Null
}
Add-LocalGroupMember -SID "S-1-5-32-545" -Member $UserName -ErrorAction SilentlyContinue
Remove-LocalGroupMember -SID "S-1-5-32-544" -Member $UserName -ErrorAction SilentlyContinue
$hide = "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon\SpecialAccounts\UserList"
New-Item $hide -Force | Out-Null
Set-ItemProperty $hide -Name $UserName -Value 0 -Type DWord

# 2. Its folder: admins write, duet-agent only reads (except logs).
Step "Installing runner and Claude Code in $Base"
Stop-ScheduledTask -TaskName $Task -ErrorAction SilentlyContinue
Get-Process node, claude -IncludeUserName -ErrorAction SilentlyContinue | Where-Object { $_.UserName -like "*\$UserName" } | Stop-Process -Force
New-Item -ItemType Directory -Force "$Base\bin", "$Base\logs" | Out-Null
icacls $Base /inheritance:r /grant:r "${Admins}:(OI)(CI)F" "${System}:(OI)(CI)F" "${UserName}:(OI)(CI)RX" /Q | Out-Null
icacls "$Base\logs" /grant "${UserName}:(OI)(CI)M" /Q | Out-Null
Copy-Item "$Repo\runner.mjs", "$Repo\claude.mjs" "$Base\bin" -Force
Copy-Item $ClaudeExe "$Base\bin\claude.exe" -Force

# 3. Tokens. The runner token lets the runner ask the gateway for work on 127.0.0.1 only.
if (-not (Test-Path "$Base\runner-token")) { Write-Text "$Base\runner-token" (New-Secret 32) }
$ct = "$Base\claude-token"
if ($NewClaudeToken -or -not (Test-Path $ct)) {
  Write-Host ""
  Write-Host "duet-agent needs its own Claude Code sign-in. In a normal (not admin) terminal run:" -ForegroundColor Yellow
  Write-Host "    claude setup-token" -ForegroundColor Yellow
  Write-Host "and paste the token it prints (it starts with sk-ant-) here. It is not shown or logged." -ForegroundColor Yellow
  $s = Read-Host "Token" -AsSecureString
  $plain = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)).Trim()
  if (-not $plain.StartsWith("sk-ant-")) { throw "That does not look like a Claude Code token (sk-ant-...). Nothing was saved." }
  Write-Text $ct $plain
  $plain = $null
}
icacls $ct /inheritance:r /grant:r "${Admins}:F" "${System}:F" "${UserName}:R" /Q | Out-Null

# 4. Workspaces it may change.
$ws = @()
foreach ($w in $Workspaces) {
  if (-not (Test-Path (Split-Path $w -Qualifier))) { Write-Warning "Skipping $w (no such drive)"; continue }
  New-Item -ItemType Directory -Force $w | Out-Null
  Step "Giving $UserName modify rights on $w (this can take a minute on big folders)"
  icacls $w /grant "${UserName}:(OI)(CI)M" /Q | Out-Null
  $ws += $w
}
if (-not $ws) { throw "No workspace folders." }

# 5. Runner settings, and the gateway's side of them.
$runner = [ordered]@{
  gateway = "http://127.0.0.1:8788"; tokenFile = "$Base\runner-token"; claudeTokenFile = $ct
  claude = @{ command = "$Base\bin\claude.exe" }; workspaces = $ws; maxParallel = 2
  permissionMode = "auto"; logFile = "$Base\logs\runner.log"
}
Write-Text "$Base\runner.json" ($runner | ConvertTo-Json -Depth 5)
& $Node "$Repo\gateway.mjs" set-runner "$Base\runner-token" $ClaudeExe @ws
if ($LASTEXITCODE) { throw "Could not update config.json" }

# 6. The task: start at boot, as duet-agent, whether or not anyone is signed in; restart if it stops.
Step "Registering task $Task"
$action = New-ScheduledTaskAction -Execute $Node -Argument "`"$Base\bin\runner.mjs`"" -WorkingDirectory "$Base\bin"
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
Register-ScheduledTask -TaskName $Task -Action $action -Trigger (New-ScheduledTaskTrigger -AtStartup) -Settings $settings `
  -User "$env:COMPUTERNAME\$UserName" -Password $pw -RunLevel Limited -Force | Out-Null
$pw = $null
Start-ScheduledTask -TaskName $Task

# 7. Restart the gateway so it opens the runner port.
if (Get-ScheduledTask -TaskName "duet-gateway" -ErrorAction SilentlyContinue) {
  Step "Restarting the duet-gateway task"
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like "*duet-gateway\gateway.mjs*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
  Start-ScheduledTask -TaskName "duet-gateway"
}

Write-Host ""
Write-Host "Done. The runner logs to $Base\logs\runner.log" -ForegroundColor Green
Write-Host "Kill switch: create duet.OFF in $Repo (stops new turns), or run: tailscale funnel reset"
