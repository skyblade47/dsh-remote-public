#!/usr/bin/env bash
# release 所有权迁移 · 影子验证总入口（硬门闸）。
# 依次跑：夹具 A（链解析）→ 夹具 B（heal 零写入）→ 夹具 C（pnpm 不实体化）→ 源码只读扫描。
# 🔴 任一不过 ⇒ 非零退出 ⇒ **真机迁移不得执行**（设计 §11 的硬门闸）。
# 🔴 全程只在 /tmp 下造树；不碰服务器、不碰 E:\ 便携版。
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

declare -a NAMES=() CODES=()
run_one() {
  local name="$1"; shift
  echo
  echo "############################################################"
  echo "# $name"
  echo "############################################################"
  "$@"; local rc=$?
  NAMES+=("$name"); CODES+=("$rc")
  if (( rc == 0 )); then echo "==> ✅ $name 通过"; else echo "==> 🔴 $name 未通过（exit=$rc）"; fi
  return 0
}

run_one "夹具 A · 链解析（A-1…A-5）"        bash "$DIR/fixture-a-chain.sh"
run_one "夹具 B · heal 零写入（B-1…B-6）"   bash "$DIR/fixture-b.sh"
run_one "夹具 C · pnpm 不实体化（C-1…C-5）" bash "$DIR/fixture-c-pnpm.sh"
run_one "交付物 4 · 源码只读扫描（S-1/S-2）" bash "$DIR/scan-profile-writes.sh"

echo
echo "================= 汇总 ================="
fail=0
for i in "${!NAMES[@]}"; do
  if (( CODES[i] == 0 )); then printf '✅ %s\n' "${NAMES[i]}"; else printf '🔴 %s（exit=%s）\n' "${NAMES[i]}" "${CODES[i]}"; fail=1; fi
done
if (( fail == 0 )); then
  echo "✅ 全部通过 ⇒ 满足真机迁移的前置条件之一（其余两条见 DEPLOY-MANUAL §17）"
  exit 0
fi
echo "🔴 有未通过项 ⇒ 真机迁移不得执行（设计 §11 硬门闸）" >&2
exit 1
