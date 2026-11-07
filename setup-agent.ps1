# setup-agent.ps1: one-time setup for Duet's normal (full-autonomy) Claude Code sessions.
# Makes a separate Windows user, "duet-agent", that cannot see Z:\ (Egnyte) or your profile, and starts
# runner.mjs as that user at every boot. Run it from an elevated PowerShell in the duet-gateway folder:
#   powershell -ExecutionPolicy Bypass -File .\setup-agent.ps1
# Run it again to update the runner or Claude Code.
# Workspaces are where duet-agent may write. Keep your own repos out of them: git hooks, .git/config, .vscode and
# .claude settings in a repo all run as you the next time you or your editor open it.
# -Protect folders are ones duet-agent may read but never change (your repos, code the gateway runs as you).
# Before the runner starts, a probe running as duet-agent proves the sandbox: it must be able to write in each workspace,
# and must fail to write in -Protect, see -EgnyteRoot, or read config.json or your profile. If anything is off, setup stops.
# Add -NewClaudeToken to replace the sign-in token, or -Uninstall to remove the user, the task and the folder.
# For scripts and CI: -ClaudeTokenFile <file> (no prompt), -GatewayDir <folder with config.json>, -NoRestartGateway.
[CmdletBinding()]
param(
  [string]$UserName = "duet-agent",
  [string[]]$Workspaces = @("D:\Duet"),
  # An explicit deny, so it also beats drive-wide grants (D:\ often lets every signed-in user modify new folders).
  [string[]]$Protect = @("D:\Projects"),
  [string]$ClaudeExe = "$env:USERPROFILE\.local\bin\claude.exe",
  # Egnyte's drive. The probe checks duet-agent cannot see it.
  [string]$EgnyteRoot = "Z:\",
  # Where gateway.mjs and config.json live. Default: this script's folder.
  [string]$GatewayDir,
  # A file holding the token from `claude setup-token`, read instead of asking.
  [string]$ClaudeTokenFile,
  [switch]$NoRestartGateway,
  [switch]$NewClaudeToken,
  [switch]$Uninstall
)
$ErrorActionPreference = "Stop"
# @() keeps a single folder an array, so $Workspaces + $Protect joins lists, not strings.
$Workspaces = @($Workspaces | ForEach-Object { $_.TrimEnd("\") })
$Protect = @($Protect | ForEach-Object { $_.TrimEnd("\") })
foreach ($w in $Workspaces) { foreach ($p in $Protect) {
  if ($w -eq $p -or $w.StartsWith("$p\", [StringComparison]::OrdinalIgnoreCase)) { throw "Workspace $w is inside protected folder $p." }
} }
$me = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $me.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw "Run this from an elevated PowerShell (right-click PowerShell > Run as administrator)." }

$Repo = $PSScriptRoot
if (-not $GatewayDir) { $GatewayDir = $PSScriptRoot }
$Base = "C:\ProgramData\duet-agent"
$Task = "duet-agent-runner"
$ProbeTask = "duet-agent-probe"
$Admins = "*S-1-5-32-544"; $System = "*S-1-5-18"
$NoBom = New-Object System.Text.UTF8Encoding $false
function Write-Text($path, $text) { [IO.File]::WriteAllText($path, $text, $NoBom) }
function New-Secret([int]$bytes) {
  $b = New-Object byte[] $bytes
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
  ([Convert]::ToBase64String($b) -replace '[+/=]', '')
}
function Step($m) { Write-Host "-> $m" -ForegroundColor Cyan }
function Get-AgentProcess { Get-Process -IncludeUserName -ErrorAction SilentlyContinue | Where-Object { $_.UserName -like "*\$UserName" } }
function Stop-Agent {
  Stop-ScheduledTask -TaskName $Task -ErrorAction SilentlyContinue
  Get-AgentProcess | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep 1
  $left = @(Get-AgentProcess)
  if ($left) { throw "Could not stop $UserName's processes: $(($left | ForEach-Object { "$($_.Name) ($($_.Id))" }) -join ', ')" }
}

if ($Uninstall) {
  Step "Removing task, user and $Base"
  Unregister-ScheduledTask -TaskName $Task -Confirm:$false -ErrorAction SilentlyContinue
  try { Stop-Agent } catch { Write-Warning "$_" }
  Unregister-ScheduledTask -TaskName $ProbeTask -Confirm:$false -ErrorAction SilentlyContinue
  foreach ($w in $Workspaces + $Protect) { if (Test-Path $w) { icacls $w /remove $UserName /T /C /Q | Out-Null } }
  Remove-LocalUser -Name $UserName -ErrorAction SilentlyContinue
  Remove-Item $Base -Recurse -Force -ErrorAction SilentlyContinue
  Write-Host "Done. C:\Users\$UserName (its profile) is left in place; delete it in System > About > Advanced > User Profiles if you want."
  return
}

$Node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $Node) { $Node = "C:\Program Files\nodejs\node.exe" }
if (-not (Test-Path $Node)) { throw "Node.js was not found." }
if (-not (Test-Path $ClaudeExe)) { throw "Claude Code was not found at $ClaudeExe. Pass -ClaudeExe <path>." }
$GatewayDir = (Resolve-Path -LiteralPath $GatewayDir).Path
$Config = Join-Path $GatewayDir "config.json"
if (-not (Test-Path -LiteralPath $Config -PathType Leaf)) { throw "No config.json in $GatewayDir. Copy config.example.json to config.json first, or pass -GatewayDir." }
if ($ClaudeTokenFile -and -not (Test-Path -LiteralPath $ClaudeTokenFile -PathType Leaf)) { throw "No token file at $ClaudeTokenFile." }
$meSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
if (-not $PSBoundParameters.ContainsKey("EgnyteRoot")) {
  # The gateway's own setting wins over the default, so the probe checks the drive Egnyte sessions really use.
  try { $e = (Get-Content -Raw -LiteralPath $Config | ConvertFrom-Json).claude.egnyteRoot; if ($e) { $EgnyteRoot = $e } } catch {}
}

# 1. The user. A new random password each run; only Task Scheduler keeps it.
$pw = (New-Secret 24) + "aA1!"
$sec = ConvertTo-SecureString $pw -AsPlainText -Force
if (Get-LocalUser -Name $UserName -ErrorAction SilentlyContinue) {
  Step "Updating user $UserName"
  Set-LocalUser -Name $UserName -Password $sec
} else {
  Step "Creating user $UserName (standard user, hidden from the sign-in screen)"
  New-LocalUser -Name $UserName -Password $sec -PasswordNeverExpires -UserMayNotChangePassword -AccountNeverExpires `
    -Description "Runs Claude Code sessions for Duet" | Out-Null
}
Add-LocalGroupMember -SID "S-1-5-32-545" -Member $UserName -ErrorAction SilentlyContinue
Remove-LocalGroupMember -SID "S-1-5-32-544" -Member $UserName -ErrorAction SilentlyContinue
$hide = "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon\SpecialAccounts\UserList"
New-Item $hide -Force | Out-Null
Set-ItemProperty $hide -Name $UserName -Value 0 -Type DWord

# 2. Its folder: admins write, duet-agent only reads (except logs).
Step "Installing runner and Claude Code in $Base"
# The old runner stays off until the probe passes and step 7 registers it again. Disable first so it is not restarted.
Disable-ScheduledTask -TaskName $Task -ErrorAction SilentlyContinue | Out-Null
Stop-Agent
New-Item -ItemType Directory -Force "$Base\bin", "$Base\logs" | Out-Null
icacls $Base /inheritance:r /grant:r "${Admins}:(OI)(CI)F" "${System}:(OI)(CI)F" "${UserName}:(OI)(CI)RX" /Q | Out-Null
icacls "$Base\logs" /grant "${UserName}:(OI)(CI)M" /Q | Out-Null
Copy-Item "$Repo\runner.mjs", "$Repo\claude.mjs" "$Base\bin" -Force
Copy-Item $ClaudeExe "$Base\bin\claude.exe" -Force
$v = & "$Base\bin\claude.exe" --version 2>&1
if ($LASTEXITCODE) { throw "The copied claude.exe does not run on its own: $v" }
Write-Host "   Claude Code $v"

# 3. Tokens. The runner token lets the runner ask the gateway for work on 127.0.0.1 only.
if (-not (Test-Path "$Base\runner-token")) { Write-Text "$Base\runner-token" (New-Secret 32) }
$ct = "$Base\claude-token"
if ($ClaudeTokenFile -or $NewClaudeToken -or -not (Test-Path $ct)) {
  if ($ClaudeTokenFile) {
    $plain = [IO.File]::ReadAllText((Resolve-Path -LiteralPath $ClaudeTokenFile).Path).Trim()
  } else {
    Write-Host ""
    Write-Host "duet-agent needs its own Claude Code sign-in. In a normal (not admin) terminal run:" -ForegroundColor Yellow
    Write-Host "    claude setup-token" -ForegroundColor Yellow
    Write-Host "and paste the token it prints (it starts with sk-ant-) here. It is not shown or logged." -ForegroundColor Yellow
    $s = Read-Host "Token" -AsSecureString
    $plain = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)).Trim()
  }
  if (-not $plain.StartsWith("sk-ant-")) { throw "That does not look like a Claude Code token (sk-ant-...). Nothing was saved." }
  Write-Text $ct $plain
  $plain = $null
}
icacls $ct /inheritance:r /grant:r "${Admins}:F" "${System}:F" "${UserName}:R" /Q | Out-Null

# 4. Workspaces it may change, folders it may not, and config.json (passphrase hash, runner token) it may not read.
$ws = @()
foreach ($w in $Workspaces) {
  if (-not (Test-Path (Split-Path $w -Qualifier))) { Write-Warning "Skipping $w (no such drive)"; continue }
  New-Item -ItemType Directory -Force $w | Out-Null
  Step "Giving $UserName modify rights on $w (this can take a minute on big folders)"
  icacls $w /grant "${UserName}:(OI)(CI)M" /Q | Out-Null
  $ws += $w
}
if (-not $ws) { throw "No workspace folders." }
foreach ($p in $Protect) {
  if (-not (Test-Path $p)) { continue }
  Step "Blocking $UserName from changing $p (it runs as you)"
  # Drop the modify grant older versions of this script gave (D:\Projects used to be a workspace), then deny writes.
  icacls $p /remove:g $UserName /Q | Out-Null
  icacls $p /deny "${UserName}:(OI)(CI)(W,D,DC)" /Q | Out-Null
}
Step "Limiting $Config to you, SYSTEM and Administrators"
# You, its owner, and the account the duet-gateway task runs as (in case you elevated with a different admin account).
$cfgUsers = @($meSid, (Get-Acl -LiteralPath $Config).GetOwner([Security.Principal.SecurityIdentifier]).Value)
$gwUser = (Get-ScheduledTask -TaskName "duet-gateway" -ErrorAction SilentlyContinue).Principal.UserId
if ($gwUser) { try { $cfgUsers += (New-Object Security.Principal.NTAccount $gwUser).Translate([Security.Principal.SecurityIdentifier]).Value } catch {} }
$cfgGrants = @($cfgUsers | Select-Object -Unique | ForEach-Object { "*${_}:F" })
icacls $Config /inheritance:r /grant:r @cfgGrants "${System}:F" "${Admins}:F" /Q | Out-Null
if ($LASTEXITCODE) { throw "Could not set permissions on $Config." }
# git run as you trusts repos you (or Administrators) own, so their hooks and config would run as you.
foreach ($w in $ws) {
  Get-ChildItem -LiteralPath $w -Filter .git -Recurse -Depth 3 -Force -ErrorAction SilentlyContinue | ForEach-Object {
    $owner = ""
    try { $owner = (Get-Acl -LiteralPath $_.FullName).GetOwner([Security.Principal.SecurityIdentifier]).Value } catch {}
    if ($owner -eq $meSid -or $owner -eq "S-1-5-32-544") {
      Write-Warning "$($_.FullName) is owned by you, so git trusts it when you run it, and duet-agent can change its hooks. Move that repo out of $w."
    }
  }
}

# 5. Prove the sandbox: run a probe as duet-agent. If it can't do what it should, or can do what it shouldn't, stop here.
$ProbeScript = @'
# probe.ps1: setup-agent.ps1 runs this once as duet-agent and reads the result from ..\logs\probe.json.
$ErrorActionPreference = "Stop"
$checks = @()
function Add-Check($id, $name, $pass, $detail, $file) {
  $script:checks += [ordered]@{ id = $id; name = $name; pass = [bool]$pass; detail = "$detail"; file = $file }
}
# $want is "works" or "denied". Only access denied counts as denied; any other error fails the check.
function Test-Access($id, $name, $want, [scriptblock]$act, $file) {
  $got = "works"; $why = ""
  try { & $act | Out-Null } catch {
    $e = $_.Exception
    while ($e.InnerException) { $e = $e.InnerException }
    $got = if ($e -is [UnauthorizedAccessException]) { "denied" } else { "error" }
    $why = $e.Message
  }
  Add-Check $id $name ($got -eq $want) ("$got $why".Trim()) $file
}
try {
  $in = [IO.File]::ReadAllText("$PSScriptRoot\probe-input.json") | ConvertFrom-Json
  $who = [Security.Principal.WindowsIdentity]::GetCurrent()
  Add-Check "notadmin" "not an administrator" (-not ([Security.Principal.WindowsPrincipal]$who).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) ""
  foreach ($w in $in.workspaces) {
    $f = "$w\.duet-probe-$($in.tag)"
    Test-Access "workspace:$w" "write and delete a file in $w" "works" {
      [IO.File]::WriteAllText($f, "probe"); [IO.File]::Delete($f)
      if ([IO.File]::Exists($f)) { throw "the file is still there" }
    } $f
  }
  foreach ($p in $in.protect) {
    # The folder and its subfolders: a subfolder with inheritance turned off would not get the deny.
    $dirs = @($p)
    try { $dirs += @([IO.Directory]::GetDirectories($p) | Select-Object -First 200) } catch {}
    foreach ($d in $dirs) {
      $f = "$d\.duet-probe-$($in.tag)"
      $id = if ($d -eq $p) { "protect:$p" } else { "protect-sub:$d" }
      Test-Access $id "create a file in $d" "denied" { [IO.File]::Open($f, "CreateNew", "Write").Dispose() } $f
      if ([IO.File]::Exists($f)) { try { [IO.File]::Delete($f) } catch {} }
    }
  }
  Test-Access "config" "read $($in.config)" "denied" { [IO.File]::OpenRead($in.config).Dispose() }
  Test-Access "profile" "list $($in.profile)" "denied" { [IO.Directory]::GetFileSystemEntries($in.profile) }
  if ($in.ssh) {
    Test-Access "ssh" "list $($in.ssh)" "denied" { [IO.Directory]::GetFileSystemEntries($in.ssh) }
    foreach ($k in $in.sshFiles) { Test-Access "ssh-file:$k" "read $k" "denied" { [IO.File]::OpenRead($k).Dispose() } }
  }
  Add-Check "egnyte" "cannot see $($in.egnyteRoot)" (-not [IO.Directory]::Exists($in.egnyteRoot)) ""
  $out = [ordered]@{ user = $who.Name; checks = $checks }
} catch {
  $out = [ordered]@{ error = "$_" }
}
[IO.File]::WriteAllText("$PSScriptRoot\..\logs\probe.json", ($out | ConvertTo-Json -Depth 5), (New-Object Text.UTF8Encoding $false))
'@
Step "Checking what $UserName can and cannot do"
$sshDir = Join-Path $env:USERPROFILE ".ssh"
$probeIn = [ordered]@{
  tag = New-Secret 9; workspaces = @($ws); protect = @($Protect | Where-Object { Test-Path -LiteralPath $_ })
  egnyteRoot = $EgnyteRoot; config = $Config; profile = $env:USERPROFILE
  ssh = $(if (Test-Path -LiteralPath $sshDir) { $sshDir } else { $null })
  sshFiles = @(Get-ChildItem -LiteralPath $sshDir -File -Recurse -Force -ErrorAction SilentlyContinue | Select-Object -First 20 | ForEach-Object { $_.FullName })
}
$probeOut = "$Base\logs\probe.json"
Remove-Item -LiteralPath $probeOut -Force -ErrorAction SilentlyContinue
if (Test-Path -LiteralPath $probeOut) { throw "Could not remove the old $probeOut." }
# Both files sit in bin, which duet-agent can read but not change.
Write-Text "$Base\bin\probe.ps1" $ProbeScript
Write-Text "$Base\bin\probe-input.json" ($probeIn | ConvertTo-Json -Depth 4)
$probeAction = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" `
  -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$Base\bin\probe.ps1`""
Unregister-ScheduledTask -TaskName $ProbeTask -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask -TaskName $ProbeTask -Action $probeAction -User "$env:COMPUTERNAME\$UserName" -Password $pw -RunLevel Limited -Force `
  -Settings (New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 5) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries) | Out-Null
try {
  Start-ScheduledTask -TaskName $ProbeTask
  # The first run also creates duet-agent's profile, which can take a while. 267009 running, 267011 not run yet, 267045 queued.
  $until = (Get-Date).AddMinutes(3)
  do {
    Start-Sleep -Milliseconds 500
    $probeInfo = Get-ScheduledTaskInfo -TaskName $ProbeTask
    $state = (Get-ScheduledTask -TaskName $ProbeTask).State
  } while (($state -eq "Running" -or $state -eq "Queued" -or $probeInfo.LastTaskResult -in 267009, 267011, 267045) -and (Get-Date) -lt $until)
} finally {
  Stop-ScheduledTask -TaskName $ProbeTask -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $ProbeTask -Confirm:$false -ErrorAction SilentlyContinue
  # The input names files in your profile; don't leave it where duet-agent can read it.
  Remove-Item -LiteralPath "$Base\bin\probe.ps1", "$Base\bin\probe-input.json" -Force -ErrorAction SilentlyContinue
}
$r = $null
try { $r = [IO.File]::ReadAllText($probeOut) | ConvertFrom-Json } catch {}
if (-not $r) { throw ("The sandbox probe did not report (task result 0x{0:X8}). The runner was not started." -f $probeInfo.LastTaskResult) }
if ($r.error) { throw "The sandbox probe failed to run: $($r.error)" }
if ("$($r.user)" -notlike "*\$UserName") { throw "The sandbox probe ran as '$($r.user)', not $UserName." }
$checks = @($r.checks)
$need = @("notadmin", "config", "profile", "egnyte") + @($probeIn.workspaces | ForEach-Object { "workspace:$_" }) + @($probeIn.protect | ForEach-Object { "protect:$_" })
if ($probeIn.ssh) { $need += "ssh" }
$bad = @()
foreach ($id in $need) { if (-not ($checks | Where-Object { $_.id -eq $id })) { $bad += "${id}: missing from the probe's report" } }
foreach ($c in $checks) {
  if ($c.pass -eq $true) { Write-Host "   ok    $($c.name)" }
  else { Write-Host "   FAIL  $($c.name) ($($c.detail))" -ForegroundColor Red; $bad += "$($c.name) ($($c.detail))" }
  # A protected-folder write that should have been refused may have left its file behind.
  if ($c.file -and "$($c.id)" -like "protect*" -and (Test-Path -LiteralPath $c.file)) { Remove-Item -LiteralPath $c.file -Force -ErrorAction SilentlyContinue }
}
if ($bad) { throw "The sandbox is not tight, so the runner was not started. Failed:`n  " + ($bad -join "`n  ") }
Write-Host "   sandbox ok" -ForegroundColor Green

# 6. Runner settings, and the gateway's side of them.
$runner = [ordered]@{
  gateway = "http://127.0.0.1:8788"; tokenFile = "$Base\runner-token"; claudeTokenFile = $ct
  claude = @{ command = "$Base\bin\claude.exe" }; workspaces = $ws; maxParallel = 2
  permissionMode = "auto"; logFile = "$Base\logs\runner.log"
}
Write-Text "$Base\runner.json" ($runner | ConvertTo-Json -Depth 5)
$oldConfigEnv = $env:DUET_GATEWAY_CONFIG
$env:DUET_GATEWAY_CONFIG = $Config
& $Node "$GatewayDir\gateway.mjs" set-runner "$Base\runner-token" $ClaudeExe @ws
$setRunnerExit = $LASTEXITCODE
$env:DUET_GATEWAY_CONFIG = $oldConfigEnv
if ($setRunnerExit) { throw "Could not update config.json" }

# 7. The task: start at boot, as duet-agent, whether or not anyone is signed in; restart if it stops.
Step "Registering task $Task"
$action = New-ScheduledTaskAction -Execute $Node -Argument "`"$Base\bin\runner.mjs`"" -WorkingDirectory "$Base\bin"
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
Register-ScheduledTask -TaskName $Task -Action $action -Trigger (New-ScheduledTaskTrigger -AtStartup) -Settings $settings `
  -User "$env:COMPUTERNAME\$UserName" -Password $pw -RunLevel Limited -Force | Out-Null
$pw = $null
# Only lines written after this start count, so an old "runner started" can't pass for a new one.
$log = "$Base\logs\runner.log"
$logLen = 0
if (Test-Path -LiteralPath $log) { $logLen = (Get-Item -LiteralPath $log).Length }
Start-ScheduledTask -TaskName $Task
$started = $false
$until = (Get-Date).AddSeconds(20)
do {
  Start-Sleep 1
  try {
    $bytes = [IO.File]::ReadAllBytes($log)
    if ($bytes.Length -gt $logLen) { $started = [Text.Encoding]::UTF8.GetString($bytes, $logLen, $bytes.Length - $logLen) -match "runner started" }
  } catch {}
} until ($started -or (Get-Date) -gt $until)
if (-not $started) {
  Write-Warning "The runner did not start (task result $((Get-ScheduledTaskInfo -TaskName $Task).LastTaskResult)). Last log lines:"
  Get-Content $log -Tail 3 -ErrorAction SilentlyContinue | ForEach-Object { Write-Host "   $_" }
} else { Write-Host "   runner is running" -ForegroundColor Green }

# 8. Restart the gateway so it opens the runner port.
if (-not $NoRestartGateway -and (Get-ScheduledTask -TaskName "duet-gateway" -ErrorAction SilentlyContinue)) {
  Step "Restarting the duet-gateway task"
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf("$GatewayDir\gateway.mjs", [StringComparison]::OrdinalIgnoreCase) -ge 0 } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
  Start-ScheduledTask -TaskName "duet-gateway"
}

Write-Host ""
Write-Host "Done. The runner logs to $Base\logs\runner.log" -ForegroundColor Green
Write-Host "Kill switch: create duet.OFF in $GatewayDir (stops new turns), or run: tailscale funnel reset"
