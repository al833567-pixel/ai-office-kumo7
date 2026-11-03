<#
  在「工作排程器」註冊常駐工作：登入時自動啟動，結束後每分鐘自動重啟。

  用法（在專案根目錄，以一般使用者身分開 PowerShell）：
    powershell -ExecutionPolicy Bypass -File scripts\windows\install-tasks.ps1 -Hub -Node -WslHermes
    powershell -ExecutionPolicy Bypass -File scripts\windows\install-tasks.ps1 -Uninstall

  參數：
    -Hub         註冊 Office Hub（只有家裡電腦 A 機要）
    -Node        註冊 Windows 端 office-node（A、B 機都要）
    -WslHermes   註冊 WSL 裡的 office-node（Hermes 接線，只有 A 機要）
    -Distro      WSL 發行版名稱（預設：wsl 的預設發行版）
    -WslProject  WSL 裡的專案路徑（預設：把這個專案的 Windows 路徑轉成 /mnt/... 路徑）
    -Uninstall   移除全部三個工作
#>
param(
  [switch]$Hub,
  [switch]$Node,
  [switch]$WslHermes,
  [string]$Distro = "",
  [string]$WslProject = "",
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
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME

function Register-OfficeTask($name, $exe, $arguments) {
  $action = New-ScheduledTaskAction -Execute $exe -Argument $arguments -WorkingDirectory $root
  Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
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
Write-Host "日誌：$root\data\logs\"
