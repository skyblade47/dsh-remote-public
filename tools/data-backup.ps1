# ============================================================================
# 使用数据备份 · 本机侧（Windows / PowerShell 5.1 兼容）
#
# 配合服务器上的 `deploy/linux/backup-data.sh`：在服务器打「使用数据」包，
# 在这里 **拉下来留存（Pull）** / **回传上去（Push）** / **对校验值（Verify）**。
#
# 用法：
#   powershell -File tools/data-backup.ps1 -Action List   -Server <ssh别名>
#   powershell -File tools/data-backup.ps1 -Action Pull   -Server <ssh别名>
#   powershell -File tools/data-backup.ps1 -Action Verify -Stamp 20260930-120000
#   powershell -File tools/data-backup.ps1 -Action Push   -Server <ssh别名> -Dir data-20260930-120000
#
# 服务器与密钥两种给法（都不写死在本文件里）：
#   -Server <ssh 别名或 user@host>      -Key <私钥路径>（不给就用 ssh 默认）
#   或环境变量：DSH_SERVER / DSH_KEY
#
# ⚠️ 本脚本只用系统自带的 ssh/scp（实测本机无 rsync，故不依赖它）。
# 退出码：0 成功；1 校验失败；2 用法/环境错误。
# ============================================================================

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][ValidateSet('List', 'Pull', 'Push', 'Verify')][string]$Action,
  [string]$Server = $env:DSH_SERVER,
  [string]$Key = $env:DSH_KEY,
  [string]$RemoteRoot = '/root/dsh-backups',
  [string]$LocalRoot = 'E:\dsh-backups',
  [string]$Stamp = '',
  [string]$Dir = '',
  [switch]$Force
)

$ErrorActionPreference = 'Stop'

function Say($m) { Write-Host $m }

# ssh / scp 的公共参数（密钥可选）
function SshArgs {
  $a = @('-o', 'ConnectTimeout=15')
  if ($Key) { $a += @('-i', $Key) }
  return $a
}

function Require-Server {
  if (-not $Server) {
    Write-Host "缺少服务器：用 -Server <ssh别名或 user@host>，或设环境变量 DSH_SERVER" -ForegroundColor Red
    exit 2
  }
}

function Run-Ssh($cmd) {
  Require-Server
  $a = SshArgs
  $out = & ssh @a $Server $cmd
  if ($LASTEXITCODE -ne 0) {
    Write-Host "远端命令失败（rc=$LASTEXITCODE）：$cmd" -ForegroundColor Red
    exit 1
  }
  return $out
}

# SHA256SUMS 是标准格式：`<sha256>  <路径>`；只按文件名比对
function Test-LocalBackup($dir) {
  $sums = Join-Path $dir 'SHA256SUMS'
  if (-not (Test-Path $sums)) {
    Say "  ⚠️ 没有 SHA256SUMS，跳过校验：$dir"
    return $true
  }
  $bad = 0
  $n = 0
  foreach ($line in (Get-Content $sums)) {
    if (-not $line.Trim()) { continue }
    $parts = $line -split '\s+', 2
    if ($parts.Count -lt 2) { continue }
    $want = $parts[0].Trim().ToLower()
    $leaf = Split-Path -Leaf $parts[1].Trim()
    $file = Join-Path $dir $leaf
    if (-not (Test-Path $file)) {
      Say "  ❌ 缺文件：$leaf"
      $bad = $bad + 1
      continue
    }
    $got = (Get-FileHash $file -Algorithm SHA256).Hash.ToLower()
    $n = $n + 1
    if ($got -ne $want) {
      Say "  ❌ 哈希不符：$leaf"
      Say "     期望 $want"
      Say "     实际 $got"
      $bad = $bad + 1
    } else {
      Say "  ✅ $leaf  sha256 一致"
    }
  }
  Say "  校验 $n 个文件，失败 $bad 个"
  return ($bad -eq 0)
}

function Remote-Stamps {
  Require-Server
  $a = SshArgs
  # 🔴 连不上 ≠ 没有备份：必须把这两件事分开（否则"服务器上没有 data-* 备份"会被当成结论，
  #    而真实原因是 ssh 连不上 —— 2026-09-30 实测踩到：ssh 别名没配 + tailnet 策略拒绝当前用户名）。
  #    远端 `ls … 2>/dev/null | sort` 的退出码取自 sort ⇒ "目录还不存在"时仍为 0，不会误判成失败。
  $errFile = [System.IO.Path]::GetTempFileName()
  # $ErrorActionPreference='Stop' 下，原生命令往 stderr 写第一行就会被 PowerShell 升级成终止错误 ⇒
  # 我们自己那句"连不上"的提示根本没机会打印。这一次调用期间降为 Continue，拿回控制权。
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $out = & ssh @a $Server "ls -1d $RemoteRoot/data-* 2>/dev/null | sort" 2>$errFile
  $rc = $LASTEXITCODE
  $ErrorActionPreference = $prev
  $err = ''
  if (Test-Path $errFile) { $err = (Get-Content $errFile -Raw) }
  Remove-Item $errFile -Force -ErrorAction SilentlyContinue
  if ($rc -ne 0) {
    Write-Host "⚠️ 连不上服务器或远端命令失败（rc=$rc）：$Server" -ForegroundColor Red
    if ($err) { Write-Host ("   " + $err.Trim().Replace("`r`n", "`n   ").Replace("`n", "`n   ")) -ForegroundColor DarkGray }
    Write-Host "   提示：-Server 要用 ssh 能直连的目标（如 root@<host>），必要时加 -Key <私钥路径>" -ForegroundColor DarkGray
    exit 1
  }
  if (-not $out) { return @() }
  return @($out | ForEach-Object { ($_ -split '/')[-1] })
}

function Resolve-Stamp {
  if ($Stamp) { return $Stamp }
  $all = @(Remote-Stamps)
  if ($all.Count -eq 0) {
    Write-Host "服务器上没有 data-* 备份 —— 先在服务器跑：bash deploy/linux/backup-data.sh" -ForegroundColor Red
    exit 2
  }
  return $all[-1]
}

if ($Action -eq 'List') {
  Say "=== 服务器 $RemoteRoot ==="
  $r = @(Remote-Stamps)
  if ($r.Count -gt 0) {
    $r | ForEach-Object { Say "  $_" }
  } else {
    Say "  （无）"
  }
  Say "=== 本机 $LocalRoot ==="
  if (Test-Path $LocalRoot) {
    $l = @(Get-ChildItem $LocalRoot -Directory -Filter 'data-*' -ErrorAction SilentlyContinue | Sort-Object Name)
    if ($l.Count -gt 0) {
      foreach ($d in $l) {
        $mb = (Get-ChildItem $d.FullName -File | Measure-Object Length -Sum).Sum / 1MB
        Say ("  {0}   {1:N1} MB" -f $d.Name, $mb)
      }
    } else {
      Say "  （无）"
    }
  } else {
    Say "  （目录不存在）"
  }
  exit 0
}

if ($Action -eq 'Pull') {
  $s = Resolve-Stamp
  $dest = Join-Path $LocalRoot $s
  if ((Test-Path $dest) -and (-not $Force)) {
    Say "本机已有 $dest（要覆盖加 -Force）"
    if (Test-LocalBackup $dest) {
      Say "✅ 该份校验通过"
      exit 0
    } else {
      exit 1
    }
  }
  New-Item -ItemType Directory -Force -Path $LocalRoot | Out-Null
  Say "拉取 $Server`:$RemoteRoot/$s  →  $LocalRoot"
  $a = SshArgs
  & scp @a -r "$Server`:$RemoteRoot/$s" $LocalRoot
  if ($LASTEXITCODE -ne 0) {
    Write-Host "scp 失败（rc=$LASTEXITCODE）" -ForegroundColor Red
    exit 1
  }
  Say "校验："
  if (Test-LocalBackup $dest) {
    Say "✅ 已备份到本机：$dest"
    Say "   还原命令见 $dest\MANIFEST.txt（在服务器上执行 tar）"
  } else {
    exit 1
  }
  exit 0
}

if ($Action -eq 'Verify') {
  $target = ''
  if ($Dir) {
    $target = Join-Path $LocalRoot $Dir
  } elseif ($Stamp) {
    $target = Join-Path $LocalRoot $Stamp
  } else {
    $l = @(Get-ChildItem $LocalRoot -Directory -Filter 'data-*' -ErrorAction SilentlyContinue | Sort-Object Name)
    if ($l.Count -eq 0) {
      Write-Host "本机 $LocalRoot 下没有 data-* 备份" -ForegroundColor Red
      exit 2
    }
    $target = $l[-1].FullName
  }
  Say "校验 $target"
  if (Test-LocalBackup $target) {
    Say "✅ 通过"
    exit 0
  } else {
    exit 1
  }
}

if ($Action -eq 'Push') {
  if (-not $Dir) {
    Write-Host "Push 需要 -Dir <本地备份目录名，如 data-20260930-120000>" -ForegroundColor Red
    exit 2
  }
  $src = Join-Path $LocalRoot $Dir
  if (-not (Test-Path $src)) {
    Write-Host "本地不存在：$src" -ForegroundColor Red
    exit 2
  }
  Say "上传 $src  →  $Server`:$RemoteRoot/"
  $a = SshArgs
  & scp @a -r $src "$Server`:$RemoteRoot/"
  if ($LASTEXITCODE -ne 0) {
    Write-Host "scp 失败（rc=$LASTEXITCODE）" -ForegroundColor Red
    exit 1
  }
  Say "远端复校验："
  Run-Ssh "cd $RemoteRoot/$Dir && sha256sum -c SHA256SUMS"
  Say "✅ 已上传到 $Server`:$RemoteRoot/$Dir"
  Say "   还原（服务器上执行，⚠️ 会覆盖同名文件）："
  Say "     tar -xzf $RemoteRoot/$Dir/dsh-home-data.tar.gz -C `$DSH_HOME"
  Say "     tar -xzf $RemoteRoot/$Dir/dsh-workspace-data.tar.gz -C `$DSH_WORKSPACE"
  exit 0
}
