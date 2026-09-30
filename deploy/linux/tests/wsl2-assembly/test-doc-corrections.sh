#!/usr/bin/env bash
# Task 8 判据（Spec② §10 更正清单 + V6）：三处更正必须落地
#   用法：bash deploy/linux/tests/wsl2-assembly/test-doc-corrections.sh
#   注：断言一律用 `|| true`（不是 `|| echo 0`）—— 后者在 0 命中时会追加第二个 0
#       （`grep -c` 0 命中既打印 0 又退出 1）⇒ 捕获 "0\n0" ≠ "0"，测试永不绿。
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
DOC="$REPO_ROOT/docs/superpowers/plans/2026-09-26-manual-whole-package-kernel-upgrade-design.md"
fails=0
chk() { if [[ "$2" == "$3" ]]; then printf '  PASS  %s\n' "$1"; else printf '  FAIL  %s：期望 %s 实际 %s\n' "$1" "$3" "$2"; fails=$((fails + 1)); fi; }

chk "§②-1(c) 标注被取代"     "$(grep -c '本节被.*local-wsl2-assembly-design.md.*取代\|被本 spec 取代' "$DOC" || true)" "1"
chk "取代块指向 Spec② 文件"   "$(grep -c '2026-09-26-local-wsl2-assembly-design.md' "$DOC" || true)" "1"
chk "取代块写明只在 WSL2"     "$(grep -c '本地测试\*\*只在 WSL2' "$DOC" || true)" "1"
chk "§A.3 #3 已结清"        "$(grep -c '本地 WSL2 侧已实测' "$DOC" || true)" "1"
chk "§A.3 #7 已采集"        "$(grep -c 'VmHWM' "$DOC" || true)" "1"
chk "§A.3 #11 已回填"       "$(grep -c 'frozen-lockfile --offline' "$DOC" || true)" "1"
# Task 1 的那半边（setup.sh 注释）
chk "setup.sh 注释已更正"    "$(grep -c '唯一真源 = 仓库根' "$REPO_ROOT/deploy/linux/setup.sh" || true)" "1"

echo "== 不过项 = $fails =="
[[ "$fails" -eq 0 ]] || exit 1
