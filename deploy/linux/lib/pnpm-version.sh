#!/usr/bin/env bash
# =============================================================================
# lib/pnpm-version.sh —— pnpm 钉版值（**唯一真源**）的读取入口
# =============================================================================
#
# 为什么单独一个文件：`pnpm` 版本此前有**两处**说法 ——
#   ① `deploy/linux/setup.sh` 里写死的 `PNPM_VERSION="12.5.1"`
#   ② 仓库根 `package.json` 的 `packageManager`（原先**根本没有**这个字段）
# 两处并存 ⇒ 迟早漂移（Spec② R4）。⇒ 现在**只认 ②**，本文件是唯一读取入口，
# `setup.sh` 与 `assemble-release.sh` 都 `source` 它，不再各自解析。
#
# 用法（在脚本里）：
#   REPO_ROOT=/path/to/repo source deploy/linux/lib/pnpm-version.sh
#   PNPM_VERSION="$(pnpm_pinned_version)" || die "读不到 pnpm 钉版"
#
# 用法（直接执行 = 打印钉版值，便于测试/人工核对）：
#   bash deploy/linux/lib/pnpm-version.sh          # → 12.5.1
#
# 退出码：0=成功  1=读不到/格式不对

# 读 `packageManager` 原文（形如 "pnpm@12.5.1"）
pnpm_package_manager_spec() {
  local root="${REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)}"
  local pkg="$root/package.json"
  if [[ ! -f "$pkg" ]]; then
    printf '[pnpm-version] 错误: 找不到真源文件 %s\n' "$pkg" >&2
    return 1
  fi
  node -e '
    const fs = require("fs")
    let p = {}
    try { p = JSON.parse(fs.readFileSync(process.argv[1], "utf8")) } catch (e) {
      process.stderr.write("[pnpm-version] 错误: package.json 不是合法 JSON\n")
      process.exit(1)
    }
    process.stdout.write(String(p.packageManager || ""))
  ' "$pkg"
}

# 只输出 `<ver>`（去掉 `pnpm@` 前缀）；格式不对 ⇒ 非 0
pnpm_pinned_version() {
  local spec
  spec="$(pnpm_package_manager_spec)" || return 1
  case "$spec" in
    pnpm@?*) printf '%s' "${spec#pnpm@}" ;;
    *)
      printf '[pnpm-version] 错误: package.json#packageManager 必须是 "pnpm@<ver>"，当前为 "%s"\n' "${spec:-<缺失>}" >&2
      return 1 ;;
  esac
}

# 直接执行 ⇒ 打印钉版值（供测试与人工核对）
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  pnpm_pinned_version || exit 1
fi
