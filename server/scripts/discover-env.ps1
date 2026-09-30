# 只读探测：定位 dsh 运行时、DSH_HOME、当前运行的 dsh 进程。
# 不修改任何文件、不启动/停止任何进程。
$ErrorActionPreference = 'SilentlyContinue'

Write-Output '=== 1. 候选安装路径 ==='
$candidates = @(
  'C:/Users/<user>\AppData\Roaming\TRAE SOLO CN\ModularData\ai-agent\work-mode-projects\6a82a06e7e4058b8d1c25ff9\dsh-desktop\dsh-runtime',
  "$env:APPDATA\dsh-desktop\dsh-data",
  'D:\dsh-dist',
  "$env:LOCALAPPDATA\Programs\DeepSeek Harness"
)
foreach ($c in $candidates) {
  if (Test-Path $c) { Write-Output "FOUND   : $c" } else { Write-Output "MISSING : $c" }
}

Write-Output ''
Write-Output '=== 2. dsh 包入口（bin.js） ==='
Get-ChildItem -Path 'C:/Users/<user>\AppData\Roaming\TRAE SOLO CN\ModularData\ai-agent\work-mode-projects\6a82a06e7e4058b8d1c25ff9\dsh-desktop' `
  -Filter 'bin.js' -Recurse -ErrorAction SilentlyContinue |
  Where-Object { $_.FullName -match 'node_modules\\@deepseek-ai\\dsh\\lib\\bin\.js$' } |
  Select-Object -First 3 -ExpandProperty FullName

Write-Output ''
Write-Output '=== 3. 运行中的 node/dsh 进程 ==='
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Select-Object ProcessId, @{n='CommandLine';e={$_.CommandLine}} |
  Format-List

Write-Output ''
Write-Output '=== 4. 监听端口（找 3080 等） ==='
Get-NetTCPConnection -State Listen |
  Where-Object { $_.LocalPort -ge 3000 -and $_.LocalPort -le 9100 } |
  Select-Object LocalAddress, LocalPort, OwningProcess |
  Sort-Object LocalPort | Format-Table -AutoSize
