#!/usr/bin/env bash
# Task 1 判据：pnpm 钉版值**只有一个真源**（仓库根 package.json#packageManager）
#   用法：bash deploy/linux/tests/wsl2-assembly/test-pnpm-single-source.sh
#   退出码：0=全过  1=有不过项
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
LIB="$REPO_ROOT/deploy/linux/lib/pnpm-version.sh"
SETUP="$REPO_ROOT/deploy/linux/setup.sh"
TPL_DIR="$REPO_ROOT/server/data/templates"
WANT="pnpm@12.5.1"

fails=0
chk() {  # $1=说明 $2=实际 $3=期望
  if [[ "$2" == "$3" ]]; then
    printf '  PASS  %s（%s）\n' "$1" "$3"
  else
    printf '  FAIL  %s：期望 %s，实际 %s\n' "$1" "$3" "$2"
    fails=$((fails + 1))
  fi
}
pm_field() {  # $1 = json 文件 → 打印 packageManager 原文
  node -e 'process.stdout.write(String(require(process.argv[1]).packageManager || ""))' "$1" 2>/dev/null
}

chk "lib 存在"        "$([[ -f "$LIB" ]] && echo yes || echo no)" "yes"
if [[ -f "$LIB" ]]; then
  chk "lib 直接执行打印钉版" "$(bash "$LIB" 2>/dev/null)" "12.5.1"
fi
chk "仓库根 packageManager"      "$(pm_field "$REPO_ROOT/package.json")" "$WANT"
# F3-2（2026-09-27 裁定，commit 1313b97）：profile 模板**不含** packageManager。
#   模板里多这一份 ⇒ frozen 下 pnpm 报 ERR_PNPM_FROZEN_LOCKFILE_WITH_OUTDATED_LOCKFILE
#   （lockfile 里没有 packageManagerDependencies 可补）⇒ 钉版值只认仓库根那一份。
for t in profile-web-minimal profile-web profile-web-release; do
  chk "模板 $t 不含 packageManager" "$(pm_field "$TPL_DIR/$t.package.json")" ""
done
chk "setup.sh 不再写死版本" "$(grep -c 'PNPM_VERSION="12.5.1"' "$SETUP" 2>/dev/null || true)" "0"
chk "setup.sh 引用 lib"    "$(grep -c 'lib/pnpm-version.sh' "$SETUP" 2>/dev/null || echo 0)"   "1"

# 变造真源 ⇒ lib 必须跟随（这才叫"唯一真源"）
T="$(mktemp -d)"
printf '{"name":"x","packageManager":"pnpm@9.9.9"}\n' > "$T/package.json"
chk "改真源后 lib 跟随" "$(REPO_ROOT="$T" bash "$LIB" 2>/dev/null)" "9.9.9"
# 缺字段 ⇒ 必须非 0（fail-closed）
printf '{"name":"x"}\n' > "$T/package.json"
REPO_ROOT="$T" bash "$LIB" >/dev/null 2>&1
chk "缺 packageManager 时 lib 退出码" "$?" "1"

echo "== 不过项 = $fails =="
[[ "$fails" -eq 0 ]] || exit 1
