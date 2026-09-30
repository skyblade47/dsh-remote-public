# 在 E 盘安装 WSL2 + Ubuntu，并准备 dsh 的 Linux 验证环境。
# 前置：WSL 运行时已就绪（wsl --version 有输出）。用法（管理员 PowerShell）：
#   .\tools\setup-wsl2.ps1
#   .\tools\setup-wsl2.ps1 -RootfsTarball E:\ubuntu-noble-wsl-amd64-24.04lts.rootfs.tar.gz
# 设计取舍：发行版磁盘与 swap 都放到 E 盘，避免占用 C 盘。
# 说明：Store 分发通道（wsl --install）在部分网络/预览版上会卡在 MSIX 部署，
# 此时用手动下载的 Ubuntu rootfs tar.gz + -RootfsTarball 更稳。
param(
  [string]$Distro = 'Ubuntu-24.04',
  [string]$InstallRoot = 'E:\WSL',
  [string]$DistroDir = 'E:\WSL\Ubuntu-24.04',
  [string]$RootfsTarball = '',
  [string]$UserName = 'dev',
  [switch]$SkipNode
)

$ErrorActionPreference = 'Stop'

function Assert-Admin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  $p = New-Object Security.Principal.WindowsPrincipal($id)
  if (-not $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw '需要管理员权限运行。'
  }
}

function Clean-WslText([string]$text) {
  # wsl.exe 输出为 UTF-16LE，被按 8 位解码后 ASCII 字符之间会夹 NUL，
  # 导致 Contains('WSL') / 正则全部失配。统一剥掉 NUL 再判断。
  return ($text -replace "`0", '')
}

# 统一封装原生命令：wsl.exe 会把提示/警告写到 stderr，而 PS 5.1 在
# $ErrorActionPreference='Stop' 下会把 stderr 当成终止性错误，导致脚本被无害警告打断。
function Invoke-Native {
  param(
    [Parameter(Mandatory = $true)][string]$Exe,
    [string[]]$CmdArgs = @(),
    [string]$Stdin = ''
  )
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    if ($Stdin) {
      $out = $Stdin | & $Exe @CmdArgs 2>&1 | Out-String
    } else {
      $out = & $Exe @CmdArgs 2>&1 | Out-String
    }
    return [pscustomobject]@{ Output = (Clean-WslText $out).Trim(); ExitCode = $LASTEXITCODE }
  } catch {
    return [pscustomobject]@{ Output = $_.Exception.Message; ExitCode = 1 }
  } finally {
    $ErrorActionPreference = $prev
  }
}

function Invoke-Wsl {
  param([string[]]$CmdArgs = @(), [string]$Stdin = '')
  return Invoke-Native -Exe 'wsl' -CmdArgs $CmdArgs -Stdin $Stdin
}

function Get-WslVersionText { return (Invoke-Wsl -CmdArgs @('--version')).Output }

function Test-WslReady {
  # 只认版本号形态，不依赖退出码（存根 wsl.exe 也会返回 0）
  return [bool]((Get-WslVersionText) -match '\d+\.\d+\.\d+')
}

function Get-InstalledDistros {
  $out = (Invoke-Wsl -CmdArgs @('--list', '--quiet')).Output
  if (-not $out) { return @() }
  return ($out -split "`r?`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ })
}

function Get-DistroLocations {
  # 从注册表取每个发行版的磁盘位置，用于判断是否落在 C 盘（键名固定为 Lxss）
  $root = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Lxss'
  if (-not (Test-Path $root)) { return @() }
  return Get-ChildItem $root | ForEach-Object {
    $p = Get-ItemProperty $_.PSPath
    if ($p.DistributionName) {
      [pscustomobject]@{ Name = $p.DistributionName; BasePath = $p.BasePath }
    }
  }
}

function Install-WslRuntime {
  Write-Host '尝试 wsl --update ...'
  Write-Host (Invoke-Wsl -CmdArgs @('--update')).Output
  for ($i = 0; $i -lt 10; $i++) {
    if (Test-WslReady) { return }
    Start-Sleep -Seconds 3
  }

  if (Get-Command winget -ErrorAction SilentlyContinue) {
    Write-Host '回退：winget 安装 Microsoft.WSL ...'
    Write-Host (Invoke-Native -Exe 'winget' -CmdArgs @(
        'install', '--id', 'Microsoft.WSL', '-e',
        '--accept-source-agreements', '--accept-package-agreements', '--disable-interactivity'
      )).Output
    for ($i = 0; $i -lt 20; $i++) {
      if (Test-WslReady) { return }
      Start-Sleep -Seconds 3
    }
  }

  # 最后回退：从 microsoft/WSL 官方发布页取最新 x64 MSI（旧的 wsl_update_x64.msi 不适配 2.x）
  Write-Host '回退：从 microsoft/WSL GitHub 官方发布页安装最新 WSL MSI ...'
  New-Item -ItemType Directory -Force -Path $InstallRoot | Out-Null
  $msi = Join-Path $InstallRoot 'wsl-latest-x64.msi'
  $rel = Invoke-RestMethod -Uri 'https://api.github.com/repos/microsoft/WSL/releases/latest' `
    -Headers @{ 'User-Agent' = 'dsh-remote-setup' }
  $asset = $rel.assets | Where-Object { $_.name -match 'x64\.msi$' } | Select-Object -First 1
  if (-not $asset) { throw '未能从 microsoft/WSL 发布页找到 x64 MSI 资产，请手动安装后重试。' }
  Write-Host "下载 $($asset.name) ..."
  Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $msi
  Start-Process msiexec.exe -ArgumentList @('/i', $msi, '/quiet', '/norestart') -Wait

  for ($i = 0; $i -lt 10; $i++) {
    if (Test-WslReady) { return }
    Start-Sleep -Seconds 3
  }
  throw 'WSL 运行时仍不可用，请确认已安装 WSL 运行时（wsl --version 有输出）。'
}

function Write-WslConfig {
  # 只写纯 ASCII 且不带注释：WSL 的 .wslconfig 解析器对 BOM 与注释行不友好，
  # 且必须无 BOM（PS 5.1 的 Set-Content -Encoding UTF8 会写 BOM）。
  New-Item -ItemType Directory -Force -Path $InstallRoot | Out-Null
  $cfgPath = Join-Path $env:USERPROFILE '.wslconfig'
  $swapPath = ($InstallRoot + '\swap.vhdx') -replace '\\', '\\'
  $lines = @(
    '[wsl2]',
    "swapFile=$swapPath",
    'swap=2GB',
    'autoMemoryReclaim=gradual',
    'memory=8GB',
    'processors=4'
  )
  $cfg = ($lines -join "`n") + "`n"
  [IO.File]::WriteAllText($cfgPath, $cfg, (New-Object Text.UTF8Encoding($false)))
  Write-Host "已写入 $cfgPath（无 BOM，无注释）"
}

function Move-DistroToE([string]$name) {
  Write-Host "把发行版 $name 迁移到 E 盘 ($DistroDir) ..."
  Write-Host (Invoke-Wsl -CmdArgs @('--terminate', $name)).Output
  $tar = Join-Path $InstallRoot "$name.tar"
  Write-Host (Invoke-Wsl -CmdArgs @('--export', $name, $tar)).Output
  if (-not (Test-Path $tar)) { throw "导出 $name 失败，未生成 tar 包。" }
  Write-Host (Invoke-Wsl -CmdArgs @('--unregister', $name)).Output
  Remove-Item -Recurse -Force $DistroDir -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Force -Path $DistroDir | Out-Null
  Write-Host (Invoke-Wsl -CmdArgs @('--import', $name, $DistroDir, $tar, '--version', '2')).Output
  Remove-Item $tar -Force -ErrorAction SilentlyContinue
  return $name
}

function Ensure-Distro {
  # 1) 已有发行版若落在 C 盘，先迁到 E 盘（Windows 自动装 Ubuntu 时默认在 C 盘）
  $sysDrive = $env:SystemDrive.ToUpper()
  $onC = @(Get-DistroLocations | Where-Object {
      $_.BasePath -and $_.BasePath.ToUpper().StartsWith($sysDrive)
    })
  if ($onC.Count -gt 0) {
    Write-Host "检测到发行版 $($onC[0].Name) 位于 $($onC[0].BasePath)（C 盘）"
    return (Move-DistroToE $onC[0].Name)
  }

  if (Get-InstalledDistros | Where-Object { $_ -eq $Distro }) {
    Write-Host "$Distro 已存在，跳过安装。"
    return $Distro
  }

  # 2) 本地 rootfs 包导入（不走 Store，最确定）
  if ($RootfsTarball) {
    if (-not (Test-Path $RootfsTarball)) { throw "未找到 rootfs 包: $RootfsTarball" }
    Write-Host "从本地 rootfs 导入 $Distro 到 $DistroDir ..."
    Remove-Item -Recurse -Force $DistroDir -ErrorAction SilentlyContinue
    New-Item -ItemType Directory -Force -Path $DistroDir | Out-Null
    $r = Invoke-Wsl -CmdArgs @('--import', $Distro, $DistroDir, $RootfsTarball, '--version', '2')
    Write-Host $r.Output
    if (-not (Get-InstalledDistros | Where-Object { $_ -eq $Distro })) {
      throw "从 $RootfsTarball 导入失败（wsl 退出码 $($r.ExitCode)）。"
    }
    return $Distro
  }

  # 3) 直接装到 E 盘（WSL 2.4.4+ 支持 --location）
  Write-Host "安装 $Distro 到 $DistroDir ..."
  Write-Host (Invoke-Wsl -CmdArgs @('--install', '-d', $Distro, '--location', $DistroDir)).Output
  if ((Get-InstalledDistros | Where-Object { $_ -eq $Distro })) { return $Distro }

  # 4) 不支持 --location 时：先装默认位置，再迁到 E 盘
  Write-Host '当前 WSL 不支持 --location，改用 导出/导入 方式迁到 E 盘 ...'
  Remove-Item -Recurse -Force $DistroDir -ErrorAction SilentlyContinue
  Write-Host (Invoke-Wsl -CmdArgs @('--install', '-d', $Distro)).Output
  Start-Sleep -Seconds 5
  if (-not (Get-InstalledDistros | Where-Object { $_ -eq $Distro })) {
    throw "安装 $Distro 失败。若 Store 通道不稳定，请手动下载 Ubuntu rootfs 后用 -RootfsTarball 指定。"
  }
  return (Move-DistroToE $Distro)
}

function Initialize-DistroUser([string]$name) {
  # import 得到的发行版以 root 登录，这里建普通用户并设为默认
  $script = @"
set -e
if ! id -u $UserName >/dev/null 2>&1; then
  useradd -m -s /bin/bash $UserName
  echo "$UserName ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/$UserName
  chmod 440 /etc/sudoers.d/$UserName
fi
printf '[user]\ndefault=$UserName\n\n[boot]\nsystemd=true\n' > /etc/wsl.conf
echo distro-user-ready
"@
  $r = Invoke-Wsl -CmdArgs @('-d', $name, '-u', 'root', '--', 'bash', '-s') -Stdin $script
  Write-Host $r.Output
  Write-Host (Invoke-Wsl -CmdArgs @('--terminate', $name)).Output
}

function Install-NodeInWsl([string]$name) {
  # 注意：官方 apt 源（archive.ubuntu.com）与 deb.nodesource.com 在国内网络常不可达，
  # 因此这里用「清华 TUNA 做 apt 源 + 国内镜像拉 Node 官方 tarball」的方式，
  # 装出的版本与本地 Windows 侧一致（v22.19.0），避免两端版本漂移。
  Write-Host '在 WSL 内安装 Node 22 与基础工具（走国内镜像）...'
  $script = @'
set -e
V=v22.19.0
F=node-$V-linux-x64.tar.xz

sudo cp /etc/apt/sources.list.d/ubuntu.sources "/etc/apt/sources.list.d/ubuntu.sources.bak-$(date +%s)" 2>/dev/null || true
sudo tee /etc/apt/sources.list.d/ubuntu.sources > /dev/null <<'EOF'
Types: deb
URIs: https://mirrors.tuna.tsinghua.edu.cn/ubuntu/
Suites: noble noble-updates noble-backports
Components: main restricted universe multiverse
Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg

Types: deb
URIs: https://mirrors.tuna.tsinghua.edu.cn/ubuntu/
Suites: noble-security
Components: main restricted universe multiverse
Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg
EOF
sudo apt-get update -qq || true
sudo apt-get install -y -qq xz-utils ca-certificates curl git unzip jq || true

cd /tmp
ok=0
for base in \
  "https://mirrors.huaweicloud.com/nodejs/$V" \
  "https://registry.npmmirror.com/-/binary/node/$V" \
  "https://mirrors.aliyun.com/nodejs-release/$V"
do
  echo "尝试镜像: $base"
  if curl -fL --retry 3 --retry-delay 2 -m 900 -o "$F" "$base/$F"; then ok=1; break; fi
done
[ "$ok" = "1" ] || { echo "Node 下载失败：所有镜像均不可达"; exit 1; }

sudo mkdir -p /usr/local/lib/nodejs
sudo tar -xJf "$F" -C /usr/local/lib/nodejs
sudo ln -sfn "/usr/local/lib/nodejs/node-$V-linux-x64/bin/node" /usr/local/bin/node
sudo ln -sfn "/usr/local/lib/nodejs/node-$V-linux-x64/bin/npm" /usr/local/bin/npm
sudo ln -sfn "/usr/local/lib/nodejs/node-$V-linux-x64/bin/npx" /usr/local/bin/npx
/usr/local/bin/npm config set registry https://registry.npmmirror.com

echo "--- 结果 ---"
/usr/local/bin/node -v
/usr/local/bin/npm -v
git --version
'@
  $r = Invoke-Wsl -CmdArgs @('-d', $name, '--', 'bash', '-s') -Stdin $script
  Write-Host $r.Output
  if ($r.ExitCode -ne 0) { Write-Host "警告：环境安装步骤退出码 $($r.ExitCode)，可稍后手动重试。" }
}

Assert-Admin
New-Item -ItemType Directory -Force -Path $InstallRoot | Out-Null

if (-not (Test-WslReady)) { Install-WslRuntime }
Write-WslConfig
Write-Host (Invoke-Wsl -CmdArgs @('--set-default-version', '2')).Output

$Distro = Ensure-Distro
Initialize-DistroUser $Distro
if (-not $SkipNode) { Install-NodeInWsl $Distro }

$loc = Get-DistroLocations | Where-Object { $_.Name -eq $Distro } | Select-Object -First 1
Write-Host ''
Write-Host ('=' * 60)
Write-Host "发行版: $Distro"
if ($loc) { Write-Host "磁盘位置: $($loc.BasePath)" }
Write-Host "验证: wsl -d $Distro -- node -v"
Write-Host "进入: wsl -d $Distro"
Write-Host ('=' * 60)
