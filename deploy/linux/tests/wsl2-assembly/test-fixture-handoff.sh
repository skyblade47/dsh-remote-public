#!/usr/bin/env bash
# Task 7 判据：交付物 6 的接口必须**成文**（路径 + 只读/可写两侧步骤 + 用途 + 校验命令）
#   用法：bash deploy/linux/tests/wsl2-assembly/test-fixture-handoff.sh
# ⚠️ 与计划 Step 1 原文的 2 处必要偏离（本文件属 Task 7 的 Files；其余逐字照抄）：
#   ① `grep -c … || echo 0` 是已知同型 bug（0 命中时既打印 `0` 又退出 1 ⇒ 捕获 "0\n0"）⇒ 改 `|| true`（同 Task 1/2/6 修法）。
#   ② 断言 2/5 原文用裸串计数，但计划 Step 3 指定的正文里 '/usr/local/dsh-release/<ver>' 落在 6 行、'夹具 B' 落在 4 行，
#      且 §8.5 既存 1 行也含前者 ⇒ 期望 "1" 不可达。改为**锚定到唯一那一行声明**（fixed-string），计数仍为 1
#      （语义 = "该声明恰好一处"，判据强度不减：锚定串本身就蕴含裸串出现）。
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
DOC="$REPO_ROOT/deploy/linux/DEPLOY-MANUAL.md"
fails=0
chk() { if [[ "$2" == "$3" ]]; then printf '  PASS  %s\n' "$1"; else printf '  FAIL  %s：期望 %s 实际 %s\n' "$1" "$3" "$2"; fails=$((fails + 1)); fi; }

chk "有 §8.8 节"          "$(grep -c '^### 8.8 ' "$DOC" || true)" "1"
chk "路径写死为 release 根" "$(grep -cF -- '| **release 绝对路径** | `/usr/local/dsh-release/<ver>`' "$DOC" || true)" "1"
chk "只读步骤（chmod）"    "$(grep -c 'chmod -R u=rwX,go=rX' "$DOC" || true)" "1"
chk "切回可写对照"         "$(grep -c 'chown -R \$(id -u):\$(id -g)' "$DOC" || true)" "1"
chk "提到 Spec① 夹具 B"    "$(grep -cF -- 'Spec①「夹具 B」' "$DOC" || true)" "1"
chk "有非 root 可读性校验"  "$(grep -c 'find .* -writable -print -quit' "$DOC" || true)" "1"

echo "== 不过项 = $fails =="
[[ "$fails" -eq 0 ]] || exit 1
