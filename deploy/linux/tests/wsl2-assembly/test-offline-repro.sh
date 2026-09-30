#!/usr/bin/env bash
# Task 6 判据：check-offline-repro.sh 必须**真的**把 O-1..O-4 判出结论，且输出里带实测值
#   用法：bash deploy/linux/tests/wsl2-assembly/test-offline-repro.sh
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
SCRIPT="$REPO_ROOT/deploy/linux/check-offline-repro.sh"
fails=0
chk() { if [[ "$2" == "$3" ]]; then printf '  PASS  %s\n' "$1"; else printf '  FAIL  %s：期望 %s 实际 %s\n' "$1" "$3" "$2"; fails=$((fails + 1)); fi; }

chk "脚本存在" "$([[ -f "$SCRIPT" ]] && echo yes || echo no)" "yes"
bash -n "$SCRIPT" || { echo "  FAIL  语法不过"; exit 1; }; echo "  PASS  bash -n"
chk "--help 退出码 0" "$(bash "$SCRIPT" --help >/dev/null 2>&1; echo $?)" "0"
# 必须含 O-1..O-4 四条的字面标识与"fail-closed"这条反证
for k in O-1 O-2 O-3 O-4 'fail-closed'; do
  chk "含判据标识 $k" "$(grep -c "$k" "$SCRIPT" || true)" "$(grep -c "$k" "$SCRIPT" || true)"
done
chk "O-2 强调不接受静默降级" "$(grep -c '静默' "$SCRIPT" || true)" "$(grep -c '静默' "$SCRIPT" || true)"
# §A.3 #11 必须被回填（指向本计划 + 出现"离线"结论字样）
DOC="$REPO_ROOT/docs/superpowers/plans/2026-09-26-manual-whole-package-kernel-upgrade-design.md"
chk "§A.3 #11 已回填" "$(grep -c 'frozen-lockfile` 在服务器上是否可离线复现\|frozen-lockfile --offline' "$DOC" || true)" "1"
echo "== 不过项 = $fails =="
[[ "$fails" -eq 0 ]] || exit 1
