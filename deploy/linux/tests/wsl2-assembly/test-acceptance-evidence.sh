#!/usr/bin/env bash
# Task 9 判据：V1..V6 的证据文件必须**都在且非空**，且 SUMMARY 里逐条判据都有结论
#   用法：bash deploy/linux/tests/wsl2-assembly/test-acceptance-evidence.sh
# ⚠️ 与计划 Step 1 原文的偏离（本文件属 Task 9 的 Files）：
#   ① 末尾两条断言的 `grep -c … || echo 0` 是已知同型 bug（0 命中时既打印 `0` 又退出 1 ⇒ 捕获 "0\n0"，
#      永远不绿）⇒ 改 `|| true`（同 Task 1/2/6/7 修法）。
#   ② 中间 `for k in …` 那条断言，计划原文两侧是**同一个表达式**
#      （`"$(grep -c "$k" "$S")" "$(grep -c "$k" "$S")"`）⇒ 恒等比较、永远 PASS，且 0 命中时同样带回 "0\n0"
#      ⇒ 起不到"SUMMARY 含某判据"的作用。改为**真实的存在性检查**（命中 ≥1 行），
#      与本 Task 的判据口径（"SUMMARY 里逐条判据都有结论"）一致。
#      代价：Step 2（SUMMARY 尚不存在）时这些行会 FAIL ⇒ 不过项数由计划的 9 变为 35（7 文件 + 26 判据 + 2 条口径断言）。
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
EV="$REPO_ROOT/docs/superpowers/evidence/2026-09-26-local-wsl2-assembly"
fails=0
chk() { if [[ "$2" == "$3" ]]; then printf '  PASS  %s\n' "$1"; else printf '  FAIL  %s：期望 %s 实际 %s\n' "$1" "$3" "$2"; fails=$((fails + 1)); fi; }

for f in V1-shape.txt V2-pnpm-pin.txt V3-offline.txt V4-smoke.txt V5-fixture.txt V6-doc-diff.txt SUMMARY.md; do
  chk "存在且非空 $f" "$([[ -s "$EV/$f" ]] && echo yes || echo no)" "yes"
done

S="$EV/SUMMARY.md"
for k in T-1 T-2 T-3 T-4 T-5 T-6 T-7 O-1 O-2 O-3 O-4 A-1 A-2 A-3 A-4 A-5 A-6 B-1 B-2 B-3 V1 V2 V3 V4 V5 V6; do
  n="$(grep -c "$k" "$S" 2>/dev/null || true)"; n="${n:-0}"
  chk "SUMMARY 含 $k" "$([[ "$n" -ge 1 ]] && echo yes || echo no)" "yes"
done
chk "SUMMARY 显式声明 B-2 口径" "$(grep -c '未跑真实对话轮次' "$S" 2>/dev/null || true)" "1"
chk "SUMMARY 列出 R1 四项差异"   "$(grep -c '网关' "$S" 2>/dev/null || true)" "1"

echo "== 不过项 = $fails =="
[[ "$fails" -eq 0 ]] || exit 1
