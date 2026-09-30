#!/usr/bin/env bash
# 迁移脚本的 --dry-run 门闸：
#   ① 默认（不带 --apply）必须**只打印**、不做任何修改；
#   ② 必须打印 0)…6) 七个步骤与全部将要执行的动作；
#   ③ 必须出现"补齐差集"（约束 2）与"删除多余链接"（约束 1）两段。
# 🔴 手工造一棵**假 release** 于 /tmp，绝不指向 /usr/local/dsh-release。
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$DIR/../../../.." && pwd)"
BASE="${REL_OWN_BASE_M:-/tmp/rel-own-migrate-dry}"
VER='0.1.5-rc.1'
[[ "$BASE" == /tmp/* ]] || { echo "🔴 BASE 必须在 /tmp 下" >&2; exit 1; }

sudo rm -rf "$BASE"
REL="$BASE/release/$VER"; HOME_="$BASE/home"
mkdir -p "$REL/kernel/bin" "$REL/plugins/taskkit" "$REL/profile/node_modules/.pnpm" \
         "$REL/profile/node_modules/@local" "$HOME_/profiles/web/node_modules/@local"
: > "$REL/kernel/bin/dsh"; chmod +x "$REL/kernel/bin/dsh"
printf '%s\n' '{"name":"@local/taskkit","version":"1.0.0"}' > "$REL/plugins/taskkit/package.json"
# 故意留一条"release 里已不存在"的陈旧链接（约束 1 的反向对齐要删掉它）。
# 3b 修好后作用对象是 **release 侧** 的 @local（$REL/profile/node_modules/@local），故陈旧链接放这里。
ln -s "$REL/plugins/taskkit" "$REL/profile/node_modules/@local/taskkit"
ln -s "$REL/plugins/nope"   "$REL/profile/node_modules/@local/nope"
# DSH_HOME 侧实体目录（P-A 之前真机的形态）；3b 修好后**不再**改这里（改这里会被 3c 搬走 ⇒ 缺陷 1）
ln -s "$REL/plugins/taskkit" "$HOME_/profiles/web/node_modules/@local/taskkit"
ln -sfn "$REL" "$BASE/release/current"
printf '%s\n' '{"current":null,"versions":[],"pluginSet":[]}' > "$BASE/release/state.json"
printf '%s\n' '{"coreVersion":"0.1.5-rc.1","pluginSet":["taskkit"]}' > "$REL/release.json"

before="$(cd "$BASE" && find . -printf '%y %p -> %l\n' | sort)"

out="$(cd "$REPO_ROOT" && DSH_RELEASE_ROOT="$BASE/release" DSH_HOME="$HOME_" DSH_SERVICE_USER="$(id -un)" \
        bash deploy/linux/release-ownership-migrate.sh --version "$VER" 2>&1)"; rc=$?
printf '%s\n' "$out"

after="$(cd "$BASE" && find . -printf '%y %p -> %l\n' | sort)"

fail=0
chk(){ if [[ "$2" == "$3" ]]; then echo "OK  $1"; else echo "NG  $1：期望 $2，实际 $3"; fail=1; fi; }
chk "退出码 0"                      0 "$rc"
chk "默认不动作（树逐字未变）"      "$before" "$after"
chk "打印了 0) 门闸"                1 "$(printf '%s\n' "$out" | grep -c '^\[migrate\] 0)' || true)"
chk "打印了 3a 补齐差集（约束 2）"  1 "$(printf '%s\n' "$out" | grep -c '3a)' || true)"
chk "打印了 3b 遍历目录生成链接"    1 "$(printf '%s\n' "$out" | grep -c '3b)' || true)"
chk "打印了 3c P-A"                 1 "$(printf '%s\n' "$out" | grep -c '3c)' || true)"
chk "打印了 3d 加固（在 3c 之后）"   1 "$(printf '%s\n' "$out" | grep -c '3d)' || true)"
chk "打印了 6a 结构判据"             1 "$(printf '%s\n' "$out" | grep -c '6a)' || true)"
chk "打印了 4) 翻链"                1 "$(printf '%s\n' "$out" | grep -c '^\[migrate\] 4)' || true)"
chk "打印了 5) 重启"                1 "$(printf '%s\n' "$out" | grep -c '^\[migrate\] 5)' || true)"
chk "打印了 6) 验"                  1 "$(printf '%s\n' "$out" | grep -c '^\[migrate\] 6)' || true)"
chk "dry-run 标记 >= 5 处"          yes "$([[ "$(printf '%s\n' "$out" | grep -c '\[dry-run\]' || true)" -ge 5 ]] && echo yes || echo no)"
chk "点名陈旧链接 @local/nope"      yes "$(printf '%s\n' "$out" | grep -q '@local/nope' && echo yes || echo no)"

echo
if (( fail == 0 )); then echo "✅ 迁移脚本 --dry-run 门闸通过"; exit 0; fi
echo "🔴 迁移脚本 --dry-run 门闸未通过" >&2
exit 1
