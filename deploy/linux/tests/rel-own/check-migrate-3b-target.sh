#!/usr/bin/env bash
# 夹具 (a)：3b 的「作用对象」与「链接目标」
#   绿侧（默认，用仓库里的迁移脚本本体）：--dry-run 输出里必须出现
#     · **release 侧** @local 路径 <release>/<ver>/profile/node_modules/@local/<n>
#     · 链接目标 = <release>/**current**/plugins/<n>
#   红侧（--mutate：把 3b 的链接目标改回 "${p%/}"，即**写死版本** <release>/<ver>/plugins/<n>）：
#     上面两条判据必须**判失败** ⇒ 证明本夹具不是"空门闸"。
#
# 背景（缺陷 1/2）：
#   · 旧实现把链接建在 DSH_HOME 侧实体目录上，被 3c(P-A) 搬走 ⇒ release 侧 @local 从没被改过；
#   · 旧实现链接目标写死 <release>/<ver>/plugins/<n> ⇒ 翻 current 时链接不跟着走。
# 🔴 全程只在 /tmp 造树；不碰真机；不执行 --apply。
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$DIR/../../../.." && pwd)"
BASE="${REL_OWN_BASE_T:-/tmp/rel-own-3b-target}"
VER='0.1.5-rc.1'
[[ "$BASE" == /tmp/* ]] || { echo "🔴 BASE 必须在 /tmp 下" >&2; exit 1; }

SRC_SCRIPT="$REPO_ROOT/deploy/linux/release-ownership-migrate.sh"
MIG_SCRIPT="$SRC_SCRIPT"
MUTATE=0
[[ "${1:-}" == "--mutate" ]] && MUTATE=1

sudo rm -rf "$BASE"
REL_ROOT="$BASE/release"; REL="$REL_ROOT/$VER"; HOME_="$BASE/home"
mkdir -p "$REL/kernel/bin" "$REL/plugins/taskkit" "$REL/profile/node_modules/@local" \
         "$HOME_/profiles/web/node_modules"
: > "$REL/kernel/bin/dsh"
printf '%s\n' '{"current":null,"versions":[],"pluginSet":[]}' > "$REL_ROOT/state.json"
printf '%s\n' '{"name":"@local/taskkit","version":"1.0.0"}' > "$REL/plugins/taskkit/package.json"
printf '%s\n' '{"coreVersion":"0.1.5-rc.1","pluginSet":["taskkit"]}' > "$REL/release.json"
ln -sfn "$REL" "$REL_ROOT/current"

if (( MUTATE )); then
  # 造一份"带缺陷 2"的变异副本（只改 3b 的链接目标那一行）；镜像 REPO_ROOT 层级，
  # 好让脚本里的 REPO_ROOT 解析仍在 /tmp 里（不指回真仓库）。
  MUT="$BASE/mut"
  mkdir -p "$MUT/deploy/linux"
  sed 's#\$RELEASE_ROOT/current/plugins/\$name#${p%/}#' "$SRC_SCRIPT" > "$MUT/deploy/linux/release-ownership-migrate.sh"
  : > "$MUT/deploy/linux/restart-kernel.sh"   # dry-run 的 step0 只需该文件存在
  grep -qF '"${p%/}"' "$MUT/deploy/linux/release-ownership-migrate.sh" \
    || { echo "🔴 变异失败：没找到 3b 的链接目标行" >&2; exit 1; }
  MIG_SCRIPT="$MUT/deploy/linux/release-ownership-migrate.sh"
  echo "== 红侧：使用变异副本 $MIG_SCRIPT（3b 链接目标 = 写死版本）"
else
  echo "== 绿侧：使用脚本本体 $MIG_SCRIPT"
fi

out="$(cd "$REPO_ROOT" && DSH_RELEASE_ROOT="$REL_ROOT" DSH_HOME="$HOME_" DSH_SERVICE_USER="$(id -un)" \
        bash "$MIG_SCRIPT" --version "$VER" 2>&1)"; rc=$?
printf '%s\n' "$out"

want_ln="[dry-run] ln -sfn $REL_ROOT/current/plugins/taskkit $REL/profile/node_modules/@local/taskkit"
bug_ln="[dry-run] ln -sfn $REL/plugins/taskkit $REL/profile/node_modules/@local/taskkit"

fail=0
chk(){ if [[ "$2" == "$3" ]]; then echo "OK  $1"; else echo "NG  $1：期望 $2，实际 $3"; fail=1; fi; }
chk "退出码 0"                                    0 "$rc"
chk "出现 release 侧 @local + current 目标"        yes "$(printf '%s\n' "$out" | grep -qF "$want_ln" && echo yes || echo no)"
chk "不再把 <ver>/plugins 当 @local 目标"          no  "$(printf '%s\n' "$out" | grep -qF "$bug_ln" && echo yes || echo no)"

echo
if (( MUTATE )); then
  # 红侧：判据**必须**失败（上面应出现 NG 行）才算"有牙齿"
  if (( fail != 0 )); then echo "✅ (a) 红侧按预期判失败（判据有牙齿）——上面的 NG 行即证据"; exit 0; fi
  echo "🔴 (a) 红侧竟全部通过 ⇒ 判据是空门闸" >&2; exit 1
fi
if (( fail == 0 )); then echo "✅ (a) 绿侧通过：release 侧 @local + current 目标"; exit 0; fi
echo "🔴 (a) 绿侧未通过" >&2
exit 1
