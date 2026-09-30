# 把 dsh-remote 注册为 Windows 服务（开机自启 + 崩溃自动重启），用于云上 24 小时运行。
# 依赖 NSSM（https://nssm.cc/）。用法示例：
#   .\install-service.ps1 -DshHome D:\dsh-remote-data -HttpsPort 28443 -TlsSan 203.0.113.9 `
#       -DshBin D:\dsh\resources\dsh-runtime\node_modules\.bin\dsh.cmd `
#       -DshRuntimeRoot D:\dsh\resources\dsh-runtime\node_modules
#   .\install-service.ps1 -Action uninstall
# 需以管理员身份运行。
param(
  [ValidateSet('install', 'uninstall', 'status')]
  [string]$Action = 'install',
  [string]$ServiceName = 'DshRemote',
  [string]$RepoRoot = (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)),
  [string]$DshHome = 'D:\dsh-remote-data',
  [string]$HttpsPort = '28443',
  [string]$HttpPort = '8080',
  [string]$TlsSan = '',
  [string]$ListenHost = '0.0.0.0',
  [string]$DshBin = '',
  [string]$DshRuntimeRoot = '',
  [string]$NssmPath = 'nssm',
  [string]$LogDir = ''
)

$ErrorActionPreference = 'Stop'

function Assert-Admin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($id)
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw '需要以管理员身份运行 PowerShell。'
  }
}

function Get-Nssm {
  $cmd = Get-Command $NssmPath -ErrorAction SilentlyContinue
  if (-not $cmd) {
    throw "未找到 nssm（当前值: $NssmPath）。请从 https://nssm.cc/download 下载后解压，用 -NssmPath 指定 nssm.exe 的完整路径。"
  }
  return $cmd.Source
}

function Get-Service-Exists($name) {
  return $null -ne (Get-Service -Name $name -ErrorAction SilentlyContinue)
}

Assert-Admin
$nssm = Get-Nssm

if ($Action -eq 'status') {
  if (-not (Get-Service-Exists $ServiceName)) {
    Write-Host "服务 $ServiceName 未安装。"
    exit 0
  }
  Get-Service -Name $ServiceName | Format-List Name, Status, StartType
  & $nssm get $ServiceName AppParameters
  exit 0
}

if ($Action -eq 'uninstall') {
  if (Get-Service-Exists $ServiceName) {
    & $nssm stop $ServiceName | Out-Null
    & $nssm remove $ServiceName confirm | Out-Null
    Write-Host "已卸载服务 $ServiceName"
  } else {
    Write-Host "服务 $ServiceName 不存在，无需卸载。"
  }
  exit 0
}

# ---- install / update ----

$startScript = Join-Path $RepoRoot 'server\scripts\start.mjs'
if (-not (Test-Path $startScript)) {
  throw "未找到启动脚本：$startScript。请用 -RepoRoot 指定仓库根目录。"
}
$nodeCmd = (Get-Command node -ErrorAction SilentlyContinue)
if (-not $nodeCmd) { throw '未找到 node，请先安装 Node.js 22 LTS（>=22.19.0）。' }

if (-not $LogDir) { $LogDir = Join-Path $DshHome 'logs' }
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

$appParams = @(
  '"' + $startScript + '"',
  '--dsh-home', '"' + $DshHome + '"',
  '--tls',
  '--port', $HttpPort,
  '--https-port', $HttpsPort,
  '--host', $ListenHost
)
if ($TlsSan) { $appParams += @('--tls-san', '"' + $TlsSan + '"') }
if ($DshBin) { $appParams += @('--dsh-bin', '"' + $DshBin + '"') }
$appParams = $appParams -join ' '

# 服务环境变量：内核对便携版路径有硬编码，云上必须用 DSH_RUNTIME_ROOT 指过去。
$envLines = @()
if ($DshRuntimeRoot) { $envLines += "DSH_RUNTIME_ROOT=$DshRuntimeRoot" }
$envLines += "DSH_HOME=$DshHome"

if (Get-Service-Exists $ServiceName) {
  Write-Host "服务已存在，更新配置 ..."
  & $nssm stop $ServiceName | Out-Null
} else {
  Write-Host "安装服务 $ServiceName ..."
  & $nssm install $ServiceName $nodeCmd.Source | Out-Null
}

& $nssm set $ServiceName Application $nodeCmd.Source | Out-Null
& $nssm set $ServiceName AppDirectory $RepoRoot | Out-Null
& $nssm set $ServiceName AppParameters $appParams | Out-Null
if ($envLines.Count -gt 0) {
  & $nssm set $ServiceName AppEnvironmentExtra @envLines | Out-Null
}
& $nssm set $ServiceName AppStdout (Join-Path $LogDir 'service-out.log') | Out-Null
& $nssm set $ServiceName AppStderr (Join-Path $LogDir 'service-err.log') | Out-Null
& $nssm set $ServiceName AppRotateFiles 1 | Out-Null
& $nssm set $ServiceName AppRotateBytes 10485760 | Out-Null
& $nssm set $ServiceName Start SERVICE_AUTO_START | Out-Null
& $nssm set $ServiceName AppExit Default Restart | Out-Null
& $nssm set $ServiceName AppRestartDelay 5000 | Out-Null
& $nssm set $ServiceName AppStopMethodConsole 15000 | Out-Null

& $nssm start $ServiceName | Out-Null
Start-Sleep -Seconds 3

Write-Host ''
Write-Host '=' * 60
Write-Host "服务: $ServiceName（自动启动 + 崩溃重启）"
Write-Host "日志: $(Join-Path $LogDir 'service-out.log')"
Write-Host "访问: https://<你的固定IP>:$HttpsPort/app"
Write-Host ''
Write-Host '还需在云控制台与 Windows 防火墙确认：'
Write-Host "  1) 安全组只放行你的来源 IP → $HttpsPort（以及 3389）"
Write-Host '  2) 绝不对外放行 3080（内核零入站鉴权）'
Write-Host "  3) Windows 防火墙放行 $HttpsPort："
Write-Host "     New-NetFirewallRule -DisplayName 'dsh-remote' -Direction Inbound -Action Allow -Protocol TCP -LocalPort $HttpsPort -RemoteAddress <你的IP>"
Write-Host '=' * 60
