#!/usr/bin/env bash
# 夹具 (c)：判据 6a（@local/* 逐条落在 <release>/ 内 + 计数与 <release>/plugins 一一对应）
#   为什么这样测：6a 是"迁移后"的**结构核对** ⇒ 只在 --apply（非 dry-run）下真的执行
#   （--dry-run 必须能跑通并只打印：设计 §5 交付物5 / §11 V2；且 dry-run 时盘上还是迁移前形态
#    ——@local 指 /opt、3a 还没补 version-radar——在 dry-run 里判必然误报）。
#   而硬约束**禁止执行 --apply** ⇒ 本夹具从脚本里**抽出 step6_verify 的原始源码**，在 /tmp 假树里以
#   DRY_RUN=0 直接驱动它：走的正是 --apply 下同一个分支、同一份代码，只是不碰机器。
#   绿侧：@local/<x> 落在 <release>/（经 current 解析）内 ⇒ 通过（rc=0）
#   红侧①：@local/<x> 落在 <release>/ **之外**（/tmp 另一棵树）⇒ 必须判失败（rc!=0 + 报"未收拢"）
#   红侧②：逐条都落在 <release>/ 内，但条目数 ≠ <release>/plugins 目录数 ⇒ 必须判失败（rc!=0 + 报"约束 1"）
#
# 背景：A9/A10 只看 boot 的 heal 行为，**看不出 @local/* 是否真收拢到 release**
#   （原实现 13 条仍指 /opt，A9/A10 照样能过）⇒ 单独立这条结构判据。
# 🔴 全程只在 /tmp 造树；不碰真机；不执行 --apply。
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$DIR/../../../.." && pwd)"
SCRIPT="$REPO_ROOT/deploy/linux/release-ownership-migrate.sh"
BASE="${REL_OWN_BASE_6A:-/tmp/rel-own-6a}"
VER='0.1.5-rc.1'
[[ "$BASE" == /tmp/* ]] || { echo "🔴 BASE 必须在 /tmp 下" >&2; exit 1; }

# 抽出 step6_verify 的原始源码（`^step6_verify() {` 到列 0 的 `^}`），并在本夹具里 eval 出来
fn="$(sed -n '/^step6_verify() {/,/^}/p' "$SCRIPT")"
printf '%s\n' "$fn" | grep -q '6a)' || { echo "🔴 抽出的 step6_verify 里没有 6a" >&2; exit 1; }
eval "$fn"

# 6a 需要的全局量与桩（DRY_RUN=0 = 走 --apply 分支，但不真动机器）
DRY_RUN=0
SERVICE_USER="$(id -un)"
KR='/dev/null'; RESTART_KERNEL='/dev/null'; KERNEL_UNIT='dsh-kernel'; DSH_HOME="$BASE/home"
die(){ printf '🔴 %s\n' "$*" >&2; exit 1; }
warn(){ printf '⚠️  %s\n' "$*" >&2; }
log(){ printf '%s\n' "$*"; }

run_case(){
  local label="$1" link_target="$2" extra="${3:-0}"
  sudo rm -rf "$BASE/$label"
  RELEASE_ROOT="$BASE/$label/release"; TARGET="$RELEASE_ROOT/$VER"
  mkdir -p "$TARGET/plugins/taskkit" "$TARGET/profile/node_modules/@local" "$BASE/$label/outside/rogue"
  printf '%s\n' '{"name":"@local/taskkit"}' > "$TARGET/plugins/taskkit/package.json"
  ln -sfn "$TARGET" "$RELEASE_ROOT/current"
  ln -sfn "$link_target" "$TARGET/profile/node_modules/@local/rogue"
  # extra=1：再加一条**落在 release 内**的多余条目 ⇒ 逐条判据全过、但计数 2≠1（约束 1 的反例）
  (( extra )) && ln -sfn "$RELEASE_ROOT/current/plugins/taskkit" "$TARGET/profile/node_modules/@local/extra"
  local out rc
  out="$( step6_verify 2>&1 )"; rc=$?
  echo "---- [$label] @local/rogue → $link_target · 多余条目=$extra · rc=$rc"
  printf '%s\n' "$out"
  return "$rc"
}

fail=0
chk(){ if [[ "$2" == "$3" ]]; then echo "OK  $1"; else echo "NG  $1：期望 $2，实际 $3"; fail=1; fi; }

# ---- 绿侧：指向 <release>/current/plugins/<n>（落点在 <release>/ 内）
run_case green "$BASE/green/release/current/plugins/taskkit" >/dev/null 2>&1
rc_green=$?
echo "== 绿侧 rc=$rc_green"
chk "绿侧（落点在 release 内）⇒ rc=0" 0 "$rc_green"

# ---- 红侧：指向 <release>/ 之外
out_red="$(run_case red "$BASE/red/outside/rogue" 2>&1)"; rc_red=$?
echo "== 红侧 rc=$rc_red"
printf '%s\n' "$out_red"
chk "红侧（落点在 release 外）⇒ rc!=0" yes "$([[ "$rc_red" != 0 ]] && echo yes || echo no)"
chk "红侧 ⇒ 报 6a 未收拢"             yes "$(printf '%s\n' "$out_red" | grep -qF '6a 未收拢' && echo yes || echo no)"

# ---- 红侧②：逐条都在 release 内，但 @local 条目数 ≠ <release>/plugins 目录数（约束 1）
out_cnt="$(run_case count "$BASE/count/release/current/plugins/taskkit" 1 2>&1)"; rc_cnt=$?
echo "== 计数不等侧 rc=$rc_cnt"
printf '%s\n' "$out_cnt"
chk "计数不等 ⇒ rc!=0"        yes "$([[ "$rc_cnt" != 0 ]] && echo yes || echo no)"
chk "计数不等 ⇒ 报 约束 1"    yes "$(printf '%s\n' "$out_cnt" | grep -qF '违反约束 1' && echo yes || echo no)"

echo
if (( fail == 0 )); then echo "✅ (c) 判据 6a 红绿两侧符合预期"; exit 0; fi
echo "🔴 (c) 判据 6a 未按预期" >&2
exit 1
