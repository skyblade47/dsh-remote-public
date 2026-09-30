#!/usr/bin/env bash
# 夹具 C「pnpm 不实体化」：在"node_modules 是软链"的 profile 上跑钉版 pnpm install。
# 判据 C-1 pnpm -v == 12.5.1 / C-2 install exit 0 / C-3 之后仍是软链 /
#      C-4 readlink 未变 / C-5 release 外无副本。
# 🔴 全部在 /tmp 下造树；不碰服务器、不碰 E:\ 便携版。
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BASE="${REL_OWN_BASE_C:-/tmp/rel-own-fixture-c}"
PNPM_VER='12.5.1'
REGISTRY="${REL_OWN_REGISTRY:-https://registry.npmmirror.com}"

[[ "$BASE" == /tmp/* ]] || { echo "🔴 REL_OWN_BASE_C 必须在 /tmp 下（当前 $BASE）" >&2; exit 1; }

fail=0
say(){ printf '%s\n' "$*"; }
chk(){ if [[ "$2" == "$3" ]]; then say "OK  $1（$3）"; else say "NG  $1：期望 $2，实际 $3"; fail=1; fi; }

bash "$DIR/prepare-tools.sh" || { echo "🔴 前置工具失败" >&2; exit 1; }
PNPM="${REL_OWN_TOOLS:-/tmp/rel-own-tools}/pnpm/node_modules/.bin/pnpm"

say "=== 建树：release 可写（本夹具只验'不实体化'，不涉及只读）==="
sudo rm -rf "$BASE"
REL="$BASE/release/0.1.5-rc.1"
PROF="$BASE/home/<user>/web"
mkdir -p "$REL/profile/node_modules" "$PROF"
ln -s "$REL/profile/node_modules" "$PROF/node_modules"
printf '%s\n' '{' \
  '  "name": "web-profile",' \
  '  "private": true,' \
  '  "dependencies": { "ms": "2.1.3" },' \
  '  "dsh": { "profile": { "bundles": ["@local/dsh-adapter"] } }' \
  '}' > "$PROF/package.json"
printf 'packages: []\n' > "$PROF/pnpm-workspace.yaml"

say "=== C-1 pnpm 版本必须 == $PNPM_VER ==="
got="$("$PNPM" --version)"
chk "C-1 pnpm -v" "$PNPM_VER" "$got"

link0="$(readlink "$PROF/node_modules")"

say "=== C-2 在软链 node_modules 上跑 pnpm install ==="
( cd "$PROF" && "$PNPM" install --registry="$REGISTRY" ) > "$BASE/install.log" 2>&1
rc=$?
tail -12 "$BASE/install.log"
chk "C-2 install 退出码" 0 "$rc"

say "=== C-3 / C-4 形态与目标 ==="
if [[ -L "$PROF/node_modules" ]]; then chk "C-3 之后仍是软链" yes yes; else chk "C-3 之后仍是软链" yes no; fi
chk "C-4 readlink 目标未变" "$link0" "$(readlink "$PROF/node_modules")"

say "=== C-5 release 外无副本 ==="
outside="$(find "$BASE/home" -mindepth 1 -maxdepth 6 \( -name '.pnpm' -o -name 'node_modules' \) 2>/dev/null \
           | grep -v "^$PROF/node_modules$" | grep -v "^$REL" || true)"
chk "C-5 release 外无 node_modules/.pnpm 副本" "" "$outside"
say "   （.pnpm 实际落点：$(find "$REL/profile/node_modules" -maxdepth 1 -name '.pnpm' || true)）"

echo
if (( fail == 0 )); then echo "✅ 夹具 C 通过（C-1…C-5）"; exit 0; fi
echo "🔴 夹具 C 未通过" >&2
exit 1
