#!/usr/bin/env bash
# ModuleGraphBuster 跨版本矩阵（M5 / N6）—— 在多个 Node 版本上跑 tools/buster-selftest.mjs
#
# 为什么需要跑真矩阵而不是只看代码分支：buster 的能力取决于宿主有没有模块钩子 API，
# 而"哪几档能力"是**实测**出来的，文档上查不到（本仓库踩到过：Node 18.19+ 也 backport 了
# `register`，所以 18 并不走 L3）。矩阵的退出判据见 buster-selftest.mjs 顶部注释。
#
# 用法：
#   tools/buster-matrix.sh                    # 只跑已装好的版本
#   tools/buster-matrix.sh --download         # 缺哪个版本就用镜像下（需可写 NODE_BASE）
#   NODE_BASE=/usr/local/lib/nodejs tools/buster-matrix.sh
#
# 默认版本集：16（验 L3 —— 两个 API 都没有）/ 18 / 20 / 22（生产在用）/ 24
set -uo pipefail

NODE_BASE="${NODE_BASE:-/usr/local/lib/nodejs}"
VERSIONS="${VERSIONS:-v16.20.2 v18.20.4 v20.19.0 v22.19.0 v24.9.0}"
WANT_DOWNLOAD=0
[[ "${1:-}" == "--download" ]] && WANT_DOWNLOAD=1

HERE="$(cd "$(dirname "$0")" && pwd)"
PKG_ROOT="$(cd "$HERE/.." && pwd)"
SELFTEST="$HERE/buster-selftest.mjs"

# 镜像按"国内可达性"排序；下载大文件要限速，否则会被中途掐断（实测 curl: (18) partial file）
MIRRORS=(
  "https://registry.npmmirror.com/-/binary/node"
  "https://mirrors.tuna.tsinghua.edu.cn/nodejs-release"
)

say() { printf '\n===== %s =====\n' "$*"; }

fetch_one() {
  local v="$1" d="$NODE_BASE/node-$v-linux-x64"
  [[ -x "$d/bin/node" ]] && return 0
  [[ "$WANT_DOWNLOAD" == "1" ]] || { echo "  $v: 未安装（加 --download 可自动下载）"; return 1; }
  local work="${WORK:-/tmp/dsh-node-dl}"; mkdir -p "$work" 2>/dev/null || true
  for m in "${MIRRORS[@]}"; do
    for attempt in 1 2 3; do
      rm -f "$work/node-$v-linux-x64.tar.xz"
      if curl -sS --ipv4 -L --retry 3 --retry-delay 2 --retry-all-errors \
           --connect-timeout 20 --max-time 600 --limit-rate 8M \
           -o "$work/node-$v-linux-x64.tar.xz" \
           "$m/$v/node-$v-linux-x64.tar.xz" 2>&1 \
         && tar -tJf "$work/node-$v-linux-x64.tar.xz" >/dev/null 2>&1; then
        tar -xJf "$work/node-$v-linux-x64.tar.xz" -C "$NODE_BASE" && return 0
      fi
      echo "    $v 第 $attempt 次失败（镜像 $m）"
    done
  done
  return 1
}

say "0) 准备各版本（NODE_BASE=$NODE_BASE）"
for v in $VERSIONS; do fetch_one "$v" && echo "  就绪 $v"; done

say "1) 各版本的模块钩子能力（这是矩阵的「期望值」来源）"
for v in $VERSIONS; do
  d="$NODE_BASE/node-$v-linux-x64"
  [[ -x "$d/bin/node" ]] || continue
  "$d/bin/node" -e 'const m=require("node:module");console.log("  "+process.version+"  registerHooks="+(typeof m.registerHooks)+"  register="+(typeof m.register))'
done

say "2) 逐版本自检"
PASS=0; FAIL=0
for v in $VERSIONS; do
  d="$NODE_BASE/node-$v-linux-x64"
  [[ -x "$d/bin/node" ]] || continue
  echo
  echo "----------------------- $v -----------------------"
  "$d/bin/node" "$SELFTEST"
  rc=$?
  echo "  ---- 退出码: $rc"
  if [[ "$rc" == "0" ]]; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); fi
done

say "3) 汇总：通过 $PASS / 异常 $FAIL"
if [[ "$FAIL" == "0" && "$PASS" != "0" ]]; then echo "  ✅ 矩阵结论全部正确"; exit 0; fi
echo "  ❌ 有版本结论异常或没有可跑版本"
exit 1
