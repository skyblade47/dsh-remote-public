#!/usr/bin/env bash
# 夹具 B「heal 零写入」门闸（B-1…B-6）：
#   · 以**非 root** 身份跑（本脚本直接拒 root）
#   · release 按真机口径置成 root:root + chmod -R u=rwX,go=rX（只读）
#   · 直接 import @deepseek-ai/dsh-app-boot 调 heal，观察"是抛错还是静默"
# 🔴 全部在 /tmp 下造树；不碰服务器、不碰 E:\ 便携版。
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BASE="${REL_OWN_BASE:-/tmp/rel-own-fixture-b}"

[[ "$BASE" == /tmp/* ]] || { echo "🔴 REL_OWN_BASE 必须在 /tmp 下（当前 $BASE）" >&2; exit 1; }
[[ "$(id -u)" != "0" ]] || { echo "🔴 必须以**非 root** 运行本夹具（现在 uid=0）" >&2; exit 1; }

fail=0
say(){ printf '%s\n' "$*"; }
chk(){ if [[ "$2" == "$3" ]]; then say "OK  $1（$3）"; else say "NG  $1：期望 $2，实际 $3"; fail=1; fi; }
jget(){ node -e "process.stdout.write(String(require(process.argv[1])${2}))" "$1"; }

bash "$DIR/prepare-tools.sh" || { echo "🔴 前置工具失败" >&2; exit 1; }

say "=== 建树（b2 = 条目逐条对齐）==="
sudo rm -rf "$BASE"
node "$DIR/fixture-b-build.mjs" || exit 1

say "=== 把 release 置成 root:root + 只读（与真机同口径）==="
for c in b2 b3 b4; do
  sudo chown -R root:root "$BASE/$c/release"
  sudo chmod -R u=rwX,go=rX "$BASE/$c/release"
done
ls -ld "$BASE/b2/release/0.1.5-rc.1/profile/node_modules"

say "=== B-1 / B-2：条目逐条对齐 ⇒ 不抛、不替换、零写入 ==="
node "$DIR/fixture-b-heal.mjs" "$BASE/b2" b2 > "$BASE/b2/result.json"
cat "$BASE/b2/result.json"
chk "B-1 跑完仍是软链（未被替换）"     true "$(jget "$BASE/b2/result.json" '.isLinkAfter')"
chk "B-1 readlink 目标未变"             "$(jget "$BASE/b2/result.json" '.targetBefore')" "$(jget "$BASE/b2/result.json" '.targetAfter')"
chk "B-2 无异常抛出"                    "" "$(jget "$BASE/b2/result.json" '.errCode')"
chk "B-2 release 内零新增/零删除"       false "$(jget "$BASE/b2/result.json" '.releaseChanged')"

say "=== B-3 故意少一条 ⇒ 复现 EACCES 崩（证明只读保护真的会拦）==="
node "$DIR/fixture-b-heal.mjs" "$BASE/b3" b3 > "$BASE/b3/result.json"
cat "$BASE/b3/result.json"
chk "B-3 抛出 EACCES"                 EACCES "$(jget "$BASE/b3/result.json" '.errCode')"
chk "B-3 报错来自 symlinkSync（新建穿过软链）" true \
  "$(node -e "process.stdout.write(String(/symlink/.test(require(process.argv[1]).errMessage)))" "$BASE/b3/result.json")"
chk "B-3 release 内零变化（写被拦住了）" false "$(jget "$BASE/b3/result.json" '.releaseChanged')"

say "=== B-4 故意多一条 ⇒ 复现 removeProfileSymlink 的 unlink EACCES 崩 ==="
node "$DIR/fixture-b-heal.mjs" "$BASE/b4" b4 > "$BASE/b4/result.json"
cat "$BASE/b4/result.json"
chk "B-4 抛出 EACCES"                 EACCES "$(jget "$BASE/b4/result.json" '.errCode')"
chk "B-4 报错来自 unlink（删除穿过软链）" true \
  "$(node -e "process.stdout.write(String(/unlink/.test(require(process.argv[1]).errMessage)))" "$BASE/b4/result.json")"
chk "B-4 release 内零变化（写被拦住了）" false "$(jget "$BASE/b4/result.json" '.releaseChanged')"

say "=== B-5 🔴 可写对照：把同一夹具（b3，少一条）的 release 放开写权限后重跑 ==="
say "    ⇒ 必须观察到写入发生。没有这条，B-2 的'零写入'无法区分「没写」与「没跑」。"
sudo chmod -R a+w "$BASE/b3/release"
node "$DIR/fixture-b-heal.mjs" "$BASE/b3" b5-writable > "$BASE/b3/result-b5.json"
cat "$BASE/b3/result-b5.json"
chk "B-5 可写时无异常"                     ""     "$(jget "$BASE/b3/result-b5.json" '.errCode')"
chk "B-5 可写时必须观察到写入发生"         true   "$(jget "$BASE/b3/result-b5.json" '.releaseChanged')"

say "=== B-6 用 A9/A10 判据脚本判 B-2 / B-3 / B-4（证明判据不空过）==="
node "$DIR/judge-a9a10.mjs" "$BASE/b2" "$BASE/b2/release" "$BASE/b2/home/<user>/web/node_modules" --expect-pass \
  && say "OK  B-6 b2 ⇒ OK" || { say "NG  B-6 b2 应判 OK"; fail=1; }
node "$DIR/judge-a9a10.mjs" "$BASE/b3" "$BASE/b3/release" "$BASE/b3/home/<user>/web/node_modules" --expect-fail \
  && say "OK  B-6 b3 ⇒ FAIL（判据不空过）" || { say "NG  B-6 b3 应判 FAIL"; fail=1; }
node "$DIR/judge-a9a10.mjs" "$BASE/b4" "$BASE/b4/release" "$BASE/b4/home/<user>/web/node_modules" --expect-fail \
  && say "OK  B-6 b4 ⇒ FAIL（判据不空过）" || { say "NG  B-6 b4 应判 FAIL"; fail=1; }

echo
if (( fail == 0 )); then echo "✅ 夹具 B（B-1…B-6）通过"; exit 0; fi
echo "🔴 夹具 B 未通过" >&2
exit 1
