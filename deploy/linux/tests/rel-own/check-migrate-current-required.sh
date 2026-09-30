#!/usr/bin/env bash
# 夹具 (b)：3b 在「没有 <release>/current」时 fail-closed
#   3b 修好后链接目标一律是 <release>/current/plugins/<n> ⇒ 没有 current 就建不出"翻链即生效"的链接，
#   必须先 install / 先翻链 ⇒ **fail-closed**（不许静默退化成写死版本，否则缺陷 2 复活）。
#   绿侧：current 存在 ⇒ 脚本 --dry-run 退出码 0
#   红侧：删掉 current ⇒ 脚本 --dry-run 必须**非零退出**并在 stderr 报 fail-closed 文案
# 🔴 全程只在 /tmp 造树；不碰真机；不执行 --apply。
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$DIR/../../../.." && pwd)"
BASE="${REL_OWN_BASE_C:-/tmp/rel-own-current-required}"
VER='0.1.5-rc.1'
[[ "$BASE" == /tmp/* ]] || { echo "🔴 BASE 必须在 /tmp 下" >&2; exit 1; }

sudo rm -rf "$BASE"
REL_ROOT="$BASE/release"; REL="$REL_ROOT/$VER"; HOME_="$BASE/home"
mkdir -p "$REL/kernel/bin" "$REL/plugins/taskkit" "$REL/profile/node_modules/@local" \
         "$HOME_/profiles/web/node_modules"
: > "$REL/kernel/bin/dsh"
printf '%s\n' '{"current":null,"versions":[],"pluginSet":[]}' > "$REL_ROOT/state.json"
printf '%s\n' '{"name":"@local/taskkit","version":"1.0.0"}' > "$REL/plugins/taskkit/package.json"
printf '%s\n' '{"coreVersion":"0.1.5-rc.1","pluginSet":["taskkit"]}' > "$REL/release.json"
ln -sfn "$REL" "$REL_ROOT/current"

run_mig(){
  ( cd "$REPO_ROOT" && DSH_RELEASE_ROOT="$REL_ROOT" DSH_HOME="$HOME_" DSH_SERVICE_USER="$(id -un)" \
      bash deploy/linux/release-ownership-migrate.sh --version "$VER" 2>&1 )
}

fail=0
chk(){ if [[ "$2" == "$3" ]]; then echo "OK  $1"; else echo "NG  $1：期望 $2，实际 $3"; fail=1; fi; }

# ---- 绿侧：current 存在
out_ok="$(run_mig)"; rc_ok=$?
echo "== 绿侧（有 current）rc=$rc_ok"
chk "有 current ⇒ 退出码 0" 0 "$rc_ok"

# ---- 红侧：删掉 current
rm -f "$REL_ROOT/current"
out_bad="$(run_mig)"; rc_bad=$?
echo "== 红侧（无 current）rc=$rc_bad"
printf '%s\n' "$out_bad" | grep -F '3b' || true
chk "无 current ⇒ 非零退出" yes "$([[ "$rc_bad" != 0 ]] && echo yes || echo no)"
chk "无 current ⇒ 报 3b fail-closed" yes "$(printf '%s\n' "$out_bad" | grep -qF '没有 current 就 fail-closed' && echo yes || echo no)"

echo
if (( fail == 0 )); then echo "✅ (b) 3b 无 current ⇒ fail-closed（红绿两侧符合预期）"; exit 0; fi
echo "🔴 (b) 3b 无 current 的 fail-closed 判据未通过" >&2
exit 1
