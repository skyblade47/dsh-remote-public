# 拉取终端客户端仓库（dsh-remote-client）到本地。
#
# 客户端已从本仓库拆分为独立仓库，本仓库不再保存客户端源码副本（避免两边版本漂移）。
# 网关默认从 <仓库根>\client\web 读取静态资源，因此本脚本默认就克隆到 <仓库根>\client，
# 这样只需执行本脚本即可让 /app 正常工作。
#
# 用法：
#   .\tools\fetch-client.ps1                       # 克隆（或更新）到 <仓库根>\client
#   .\tools\fetch-client.ps1 -Dest E:\web-client   # 克隆到外部目录（需配 DSH_GATEWAY_WEB_DIR）
#   .\tools\fetch-client.ps1 -Ref v0.1.0           # 检出指定分支/标签
#
# 说明：
# - 目标已存在且是 git 仓库 → 视为更新：fetch + 切到目标 ref 并快进；
# - 目标存在但不是 git 仓库 → 报错退出，不做删除（避免误删用户文件）；
# - 克隆/更新后校验 web/index.html 存在，否则视为失败。
param(
  [string]$Repo = 'https://github.com/skyblade47/dsh-remote-client.git',
  # tools\ 的上一级就是仓库根；默认放在仓库根的 client\ 下，与网关默认 webRoot 一致
  [string]$Dest = (Join-Path (Split-Path -Parent $PSScriptRoot) 'client'),
  [string]$Ref = ''
)

$ErrorActionPreference = 'Stop'

function Invoke-Git {
  param([string[]]$GitArgs)
  $prevEap = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $out = & git @GitArgs 2>&1 | Out-String
    $code = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $prevEap
  }
  if ($code -ne 0) { throw "git $($GitArgs -join ' ') 失败（退出码 $code）：`n$($out.Trim())" }
  return $out.Trim()
}

if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw '未找到 git，请先安装 Git for Windows' }

Write-Host "客户端仓库: $Repo"
Write-Host "目标目录  : $Dest"
if ($Ref) { Write-Host "目标引用  : $Ref" }

if (Test-Path $Dest) {
  if (-not (Test-Path (Join-Path $Dest '.git'))) {
    # 兼容旧布局：拆分之前客户端源码就在本仓库的 client\ 下，是普通目录而非 git 仓库。
    # 不做删除：改名留档后重新克隆，确认无误再自行删除留档目录。
    $legacy = "$Dest.legacy-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
    Write-Host "目录已存在但不是 git 仓库（旧的内嵌客户端副本），改名为留档：$legacy"
    Move-Item -Path $Dest -Destination $legacy
    Write-Host '执行克隆 ...'
    Invoke-Git @('clone', $Repo, $Dest) | Out-Null
  } else {
    Write-Host '目录已存在，执行更新 ...'
    Invoke-Git @('-C', $Dest, 'fetch', '--prune', 'origin') | Out-Null
    if ($Ref) {
      Invoke-Git @('-C', $Dest, 'checkout', $Ref) | Out-Null
      Invoke-Git @('-C', $Dest, 'merge', '--ff-only', "origin/$Ref") | Out-Null
    } else {
      Invoke-Git @('-C', $Dest, 'pull', '--ff-only') | Out-Null
    }
  }
} else {
  Write-Host '执行克隆 ...'
  $parent = Split-Path -Parent $Dest
  if ($parent -and -not (Test-Path $parent)) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
  if ($Ref) {
    Invoke-Git @('clone', '--branch', $Ref, $Repo, $Dest) | Out-Null
  } else {
    Invoke-Git @('clone', $Repo, $Dest) | Out-Null
  }
}

# 校验：网关静态路由要求 webRoot 下存在 SPA 入口与登录页
foreach ($required in @('web\index.html', 'web\auth\login.html')) {
  $p = Join-Path $Dest $required
  if (-not (Test-Path $p)) { throw "客户端内容不完整，缺少 $required（仓库：$Repo）" }
}

$head = Invoke-Git @('-C', $Dest, 'rev-parse', '--short', 'HEAD')
Write-Host "✓ 客户端就绪：$Dest（HEAD $head）"
Write-Host ''
Write-Host ('=' * 64)
Write-Host '默认位置无需任何配置：网关从 <仓库根>\client\web 读取客户端。'
Write-Host '若克隆到了别处，启动网关时需显式指定：'
Write-Host '    $env:DSH_GATEWAY_WEB_DIR = "<Dest>\web"'
Write-Host '    node server\scripts\start.mjs --dsh-home <你的 DSH_HOME> --tls'
Write-Host ('=' * 64)
