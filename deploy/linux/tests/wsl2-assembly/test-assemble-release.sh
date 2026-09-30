#!/usr/bin/env bash
# Task 4 判据：装配器的参数校验 + pnpm 钉版 fail-closed（**不需要 root** 即可测）
#   用法：bash deploy/linux/tests/wsl2-assembly/test-assemble-release.sh
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
SCRIPT="$REPO_ROOT/deploy/linux/assemble-release.sh"
fails=0
chk() { if [[ "$2" == "$3" ]]; then printf '  PASS  %s\n' "$1"; else printf '  FAIL  %s：期望 %s 实际 %s\n' "$1" "$3" "$2"; fails=$((fails + 1)); fi; }

chk "脚本存在" "$([[ -f "$SCRIPT" ]] && echo yes || echo no)" "yes"
bash -n "$SCRIPT" || { echo "  FAIL  语法不过"; exit 1; }; echo "  PASS  bash -n"
chk "--help 退出码 0" "$(bash "$SCRIPT" --help >/dev/null 2>&1; echo $?)" "0"

# 缺 --version ⇒ exit 1
bash "$SCRIPT" >/dev/null 2>&1
chk "缺 --version ⇒ 1" "$?" "1"

# <ver> 含 / ⇒ exit 1
bash "$SCRIPT" --version a/b >/dev/null 2>&1
chk "<ver> 含 / ⇒ 1" "$?" "1"

# pnpm 路径不存在 ⇒ exit 1
bash "$SCRIPT" --version 0.1.5-rc.1 --pnpm-bin /nonexistent/pnpm >/dev/null 2>&1
chk "pnpm 不存在 ⇒ 1" "$?" "1"

# 🔴 pnpm 版本不符 ⇒ exit 3（fail-closed）
T="$(mktemp -d)"; printf '#!/bin/sh\necho 9.0.0\n' > "$T/pnpm"; chmod +x "$T/pnpm"
bash "$SCRIPT" --version 0.1.5-rc.1 --pnpm-bin "$T/pnpm" >/dev/null 2>&1
chk "pnpm 版本不符 ⇒ 3" "$?" "3"

# 版本相符的假 pnpm ⇒ 应越过 fail-closed（随后会因非 root 停下，exit 1 —— 关键是不能是 3）
printf '#!/bin/sh\necho 12.5.1\n' > "$T/pnpm"
bash "$SCRIPT" --version 0.1.5-rc.1 --pnpm-bin "$T/pnpm" >/dev/null 2>&1
rc=$?
chk "版本相符不再 3" "$([[ "$rc" != "3" ]] && echo ok || echo no)" "ok"

echo "== 不过项 = $fails =="
[[ "$fails" -eq 0 ]] || exit 1
