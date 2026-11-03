<#
  在「工作排程器」註冊常駐工作：登入時自動啟動，不開視窗（在背景執行）。
  看門狗：每 5 分鐘觸發一次，工作已在跑就略過，沒在跑（被關掉、正常結束）就重新啟動；
  異常結束另外每分鐘重試。日誌在 data\logs\。

  用法（在專案根目錄，以一般使用者身分開 PowerShell）：
    powershell -ExecutionPolicy Bypass -File scripts\windows\install-tasks.ps1 -Hub -Node -WslHermes
    powershell -ExecutionPolicy Bypass -File scripts\windows\install-tasks.ps1 -Uninstall

  參數：
    -Hub         註冊 Office Hub（只有家裡電腦 A 機要）
    -Node        註冊 Windows 端 office-node（A、B 機都要）
    -WslHermes   註冊 WSL 裡的 office-node（Hermes 接線，只有 A 機要）
    -Distro      WSL 發行版名稱（預設：wsl 的預設發行版）
    -WslProject  WSL 裡的專案路徑（預設：把這個專案的 Windows 路徑轉成 /mnt/... 路徑）
    -Visible     顯示 cmd 視窗（除錯用；關掉視窗會停止工作，5 分鐘內由看門狗重啟）
    -Uninstall   移除全部三個工作

  停止背景執行的工作：-Uninstall，或在工作管理員結束 bun.exe。
#>
param(
  [switch]$Hub,
  [switch]$Node,
  [switch]$WslHermes,
  [string]$Distro = "",
  [string]$WslProject = "",
  [switch]$Visible,
  [switch]$Uninstall
)
$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$names = @{ Hub = "AI Office Hub"; Node = "AI Office Node"; Wsl = "AI Office Hermes (WSL)" }

if ($Uninstall) {
  foreach ($n in $names.Values) {
    if (Get-ScheduledTask -TaskName $n -ErrorAction SilentlyContinue) {
      Unregister-ScheduledTask -TaskName $n -Confirm:$false
      Write-Host "已移除：$n"
    }
  }
  exit 0
}
if (-not ($Hub -or $Node -or $WslHermes)) { Write-Host "請至少指定 -Hub、-Node、-WslHermes 其中一個。"; exit 1 }

$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
# 觸發：登入時啟動；另加每 5 分鐘一次的看門狗（MultipleInstances IgnoreNew：已在跑就略過）
$triggers = @(
  (New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME),
  (New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5))
)

# 不開視窗：用 conhost --headless 包一層（Windows 10 1903 以後內建）。沒有的話退回一般視窗。
$conhost = Join-Path $env:windir "System32\conhost.exe"
$headless = (-not $Visible) -and (Test-Path $conhost)
if (-not $Visible -and -not $headless) { Write-Host "找不到 conhost.exe，改用一般視窗執行（關掉視窗後 5 分鐘內會自動重啟）。" }

function Register-OfficeTask($name, $exe, $arguments) {
  if ($headless) { $arguments = "--headless $exe $arguments"; $exe = $conhost }
  $action = New-ScheduledTaskAction -Execute $exe -Argument $arguments -WorkingDirectory $root
  if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) { Stop-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue }
  Register-ScheduledTask -TaskName $name -Action $action -Trigger $triggers -Settings $settings -Force | Out-Null
  Start-ScheduledTask -TaskName $name
  Write-Host "已註冊並啟動：$name"
}

if ($Hub)  { Register-OfficeTask $names.Hub  "cmd.exe" "/c `"`"$root\scripts\windows\start-hub.cmd`"`"" }
if ($Node) { Register-OfficeTask $names.Node "cmd.exe" "/c `"`"$root\scripts\windows\start-office-node.cmd`"`"" }
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
Write-Host ("執行方式：" + $(if ($headless) { "背景（不開視窗）" } else { "一般視窗" }) + "；看門狗每 5 分鐘檢查一次")
Write-Host "日誌：$root\data\logs\"
Write-Host "重新註冊前若工作已在背景跑，舊的 bun.exe 可能還在：先在工作管理員結束 bun.exe，或重新登入。"
