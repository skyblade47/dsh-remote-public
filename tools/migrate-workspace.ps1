# 把 dsh-remote 工作区整体迁到另一个盘（默认 E:\projects\dsh-remote），减少 C 盘占用。
#
# 重要：请在**关闭 TRAE / 关闭本项目**之后再运行——脚本会搬移整个目录，
# 运行中搬移会让当前会话与文件句柄失效。
#
# 用法（普通 PowerShell 即可，不需要管理员，除非目标目录需要权限）：
#   .\tools\migrate-workspace.ps1                        # 迁到 E:\projects\dsh-remote
#   .\tools\migrate-workspace.ps1 -TargetRoot D:\work    # 指定目标父目录
#   .\tools\migrate-workspace.ps1 -KeepSource            # 只复制不删源（先试跑）
#
# 说明：
# - 用 robocopy 复制，复制完成后比对「文件数 + 总字节」，一致才删源；
# - 排除 junction/符号链接（/XJ）：plugins/node_modules 与 .runtime 下的链接由
#   server\scripts\setup.mjs 重新生成，不需要跟着搬，也避免 robocopy 递归进链接。
param(
  [string]$TargetRoot = 'E:\projects',
  # tools\ 的上一级就是仓库根
  [string]$Source = (Split-Path -Parent $PSScriptRoot),
  [switch]$KeepSource
)

$ErrorActionPreference = 'Stop'

function Measure-Tree([string]$path) {
  $files = Get-ChildItem $path -Recurse -File -Force -ErrorAction SilentlyContinue |
    Where-Object { -not $_.Attributes.ToString().Contains('ReparsePoint') }
  $dirs = Get-ChildItem $path -Recurse -Directory -Force -ErrorAction SilentlyContinue |
    Where-Object { -not $_.Attributes.ToString().Contains('ReparsePoint') }
  return [pscustomobject]@{
    Files = ($files | Measure-Object).Count
    Dirs  = ($dirs | Measure-Object).Count
    Bytes = ($files | Measure-Object -Property Length -Sum).Sum
  }
}

$Source = (Resolve-Path $Source).Path
$ProjectName = Split-Path -Leaf $Source
$Target = Join-Path $TargetRoot $ProjectName

Write-Host "源目录: $Source"
Write-Host "目标目录: $Target"

if (-not (Test-Path $Source)) { throw "源目录不存在: $Source" }
if (Test-Path $Target) { throw "目标目录已存在，请先清空或换 -TargetRoot: $Target" }

# 1) git 状态检查：确保没有未提交改动、且本地提交已推送
Push-Location $Source
try {
  if (-not (Test-Path (Join-Path $Source '.git'))) {
    throw "源目录不是 git 仓库（缺 .git）：$Source。请用 -Source 指定仓库根目录。"
  }
  $prevEap = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $dirty = (git status --porcelain 2>&1 | Out-String).Trim()
    $head = (git rev-parse HEAD 2>&1 | Out-String).Trim()
    $remote = (git rev-parse origin/main 2>&1 | Out-String).Trim()
  } finally {
    $ErrorActionPreference = $prevEap
  }

  if ($dirty) {
    Write-Host '⚠ 工作区有未提交改动：'
    $dirty -split "`r?`n" | ForEach-Object { Write-Host "    $_" }
    throw '请先提交并推送，避免搬迁过程中丢失改动。'
  }
  if ($remote -notmatch '^[0-9a-f]{7,40}$') { $remote = '' }
  if ($head -notmatch '^[0-9a-f]{7,40}$') { throw "无法读取 git HEAD（输出：$head）" }

  if ($remote -and $remote -ne $head) {
    Write-Host "⚠ 本地 HEAD($($head.Substring(0,8))) 与 origin/main($($remote.Substring(0,8))) 不一致"
    Write-Host '  建议先 git push，确保远端有完整历史再搬迁。'
  } else {
    Write-Host "✓ git 状态干净，且与 origin/main 同步（$($head.Substring(0,8))）"
  }
} finally {
  Pop-Location
}

# 2) 记录源规模
$before = Measure-Tree $Source
Write-Host "源规模: $($before.Files) 文件 / $($before.Dirs) 目录 / $([math]::Round($before.Bytes/1MB,1)) MB（不含链接）"

# 3) robocopy 复制（/XJ 排除 junction；/MT 多线程；不重试太久）
New-Item -ItemType Directory -Force -Path $Target | Out-Null
Write-Host '开始复制 ...'
$rc = robocopy $Source $Target /E /XJ /DCOPY:DAT /COPY:DAT /R:1 /W:1 /MT:16 /NFL /NDL /NP
# robocopy 退出码：0=无变化, 1=有复制, >=8 为错误
if ($LASTEXITCODE -ge 8) { throw "robocopy 失败，退出码 $LASTEXITCODE（目标目录已保留，可人工检查）" }

# 4) 校验
$after = Measure-Tree $Target
Write-Host "目标规模: $($after.Files) 文件 / $($after.Dirs) 目录 / $([math]::Round($after.Bytes/1MB,1)) MB（不含链接）"
if ($after.Files -ne $before.Files -or $after.Bytes -ne $before.Bytes) {
  throw "校验不一致：文件数 $($before.Files) → $($after.Files)，字节 $($before.Bytes) → $($after.Bytes)。已保留源目录，请人工检查。"
}
Write-Host '✓ 校验一致'

# 5) 删源
if ($KeepSource) {
  Write-Host "已按 -KeepSource 保留源目录：$Source"
} else {
  Write-Host '删除源目录 ...'
  Remove-Item -Recurse -Force $Source
  Write-Host '✓ 源目录已删除'
}

Write-Host ''
Write-Host ('=' * 64)
Write-Host '完成后请做这几件事：'
Write-Host "  1. 在 TRAE 里从新路径重新打开本项目：$Target"
Write-Host '  2. 在新路径下重建运行时链接与依赖（幂等，可重复运行）：'
Write-Host "       cd $Target"
Write-Host '       node server\scripts\setup.mjs --dsh-home <你的 DSH_HOME>'
Write-Host '  3. 如需重新起本地网关：'
Write-Host '       node server\scripts\start.mjs --dsh-home <你的 DSH_HOME> --tls'
Write-Host '  4. git 远端不变，后续照常 pull / push；.runtime 与 node_modules 属可重建内容，未随迁属正常。'
Write-Host ('=' * 64)
