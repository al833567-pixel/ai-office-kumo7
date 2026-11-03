<#
  在「工作排程器」註冊工作：登入時開一個命令列視窗執行，關掉視窗就停止（不會自動重開）。
  日誌在 data\logs\。

  用法（在專案根目錄開 PowerShell；之前用系統管理員註冊過的，這次也要用系統管理員）：
    powershell -ExecutionPolicy Bypass -File scripts\windows\install-tasks.ps1 -Hub -Node
    powershell -ExecutionPolicy Bypass -File scripts\windows\install-tasks.ps1 -Uninstall

  參數：
    -Hub         註冊 Office Hub（只有家裡電腦 A 機要）
    -Node        註冊 Windows 端 office-node（A、B 機都要）
    -WslHermes   註冊 WSL 裡的 office-node（Hermes 改在 WSL 跑時才要）
    -Distro      WSL 發行版名稱（預設：wsl 的預設發行版）
    -WslProject  WSL 裡的專案路徑（預設：把這個專案的 Windows 路徑轉成 /mnt/... 路徑）
    -Watchdog    （選用）看門狗：每 5 分鐘檢查，沒在跑（含被關掉）就重新開；異常結束每分鐘重試
    -Firewall    （選用，要系統管理員）加防火牆規則：只允許 Tailscale 網段 100.64.0.0/10 連 Hub 的 port；已存在就略過
    -Port        Hub 的 port（預設 7070，給 -Firewall 用）
    -Uninstall   移除全部工作

  重複執行沒關係：工作已存在就覆蓋設定，並先結束這個專案舊的 bun（Hub／office-node）再啟動。
#>
param(
  [switch]$Hub,
  [switch]$Node,
  [switch]$WslHermes,
  [string]$Distro = "",
  [string]$WslProject = "",
  [switch]$Watchdog,
  [switch]$Firewall,
  [int]$Port = 7070,
  [switch]$Uninstall
)
$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$names = @{ Hub = "AI Office Hub"; Node = "AI Office Node"; Wsl = "AI Office Hermes (WSL)" }

# 結束這個專案舊的 bun：依命令列比對（Hub 是 src\server.ts，office-node 是 node\office.ts run）
function Stop-OldBun($pattern, $label) {
  $procs = @(Get-CimInstance Win32_Process -Filter "Name = 'bun.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -like $pattern })
  foreach ($p in $procs) {
    try { Stop-Process -Id $p.ProcessId -Force; Write-Host "已結束舊的 $label（bun PID $($p.ProcessId)）" }
    catch { Write-Host "無法結束 PID $($p.ProcessId)（$label）：$($_.Exception.Message)" }
  }
}

if ($Uninstall) {
  foreach ($n in $names.Values) {
    if (Get-ScheduledTask -TaskName $n -ErrorAction SilentlyContinue) {
      Stop-ScheduledTask -TaskName $n -ErrorAction SilentlyContinue
      Unregister-ScheduledTask -TaskName $n -Confirm:$false
      Write-Host "已移除：$n"
    }
  }
  exit 0
}
if (-not ($Hub -or $Node -or $WslHermes -or $Firewall)) { Write-Host "請至少指定 -Hub、-Node、-WslHermes、-Firewall 其中一個。"; exit 1 }

if ($Firewall) {
  $rule = "AI Office Hub $Port (Tailscale)"
  if (Get-NetFirewallRule -DisplayName $rule -ErrorAction SilentlyContinue) { Write-Host "防火牆規則已存在，略過：$rule" }
  else {
    try {
      New-NetFirewallRule -DisplayName $rule -Direction Inbound -Protocol TCP -LocalPort $Port -RemoteAddress 100.64.0.0/10 -Action Allow | Out-Null
      Write-Host "已加防火牆規則：$rule"
    } catch { Write-Host "加防火牆規則失敗（要用系統管理員執行）：$($_.Exception.Message)" }
  }
}

# 預設：關掉視窗就停，不自動重開。-Watchdog 才加重試與每 5 分鐘的檢查。
if ($Watchdog) {
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
  $triggers = @(
    (New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME),
    (New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5))
  )
} else {
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
  $triggers = @((New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME))
}

function Register-OfficeTask($name, $exe, $arguments) {
  $action = New-ScheduledTaskAction -Execute $exe -Argument $arguments -WorkingDirectory $root
  if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) {
    Stop-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
    Write-Host "工作已存在，更新設定：$name"
  }
  Register-ScheduledTask -TaskName $name -Action $action -Trigger $triggers -Settings $settings -Force | Out-Null
  Start-ScheduledTask -TaskName $name
  Write-Host "已註冊並啟動：$name"
}

if ($Hub) {
  Stop-OldBun "*src\server.ts*" "Hub"
  Register-OfficeTask $names.Hub "cmd.exe" "/c `"`"$root\scripts\windows\start-hub.cmd`"`""
}
if ($Node) {
  Stop-OldBun "*office.ts* run*" "office-node"
  Register-OfficeTask $names.Node "cmd.exe" "/c `"`"$root\scripts\windows\start-office-node.cmd`"`""
}
if ($WslHermes) {
  if (-not $WslProject) {
    $drive = $root.Substring(0, 1).ToLower()
    $WslProject = "/mnt/$drive" + ($root.Substring(2) -replace '\\', '/')
  }
  $d = if ($Distro) { "-d $Distro " } else { "" }
  # 用 login shell 讓 ~/.bun/bin 與 hermes 在 PATH 裡
  $cmd = "cd '$WslProject' && exec bash scripts/linux/start-office-node.sh"
  Register-OfficeTask $names.Wsl "wsl.exe" "$d-e bash -lc `"$cmd`""
}
if ($Hub -or $Node -or $WslHermes) {
  Write-Host ("執行方式：登入時開命令列視窗，關掉就停止" + $(if ($Watchdog) { "；看門狗每 5 分鐘檢查，沒在跑就重開" } else { "" }))
  Write-Host "日誌：$root\data\logs\"
}
