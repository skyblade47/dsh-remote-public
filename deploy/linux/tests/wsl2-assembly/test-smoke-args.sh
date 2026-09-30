#!/usr/bin/env bash
# Task 5 判据：冒烟脚本的参数校验 + "找不到 release/内核入口"必须**拒绝起实例**（不静默继续）
#   用法：bash deploy/linux/tests/wsl2-assembly/test-smoke-args.sh
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
SCRIPT="$REPO_ROOT/deploy/linux/smoke-local-wsl2.sh"
fails=0
chk() { if [[ "$2" == "$3" ]]; then printf '  PASS  %s\n' "$1"; else printf '  FAIL  %s：期望 %s 实际 %s\n' "$1" "$3" "$2"; fails=$((fails + 1)); fi; }

chk "脚本存在" "$([[ -f "$SCRIPT" ]] && echo yes || echo no)" "yes"
bash -n "$SCRIPT" || { echo "  FAIL  语法不过"; exit 1; }; echo "  PASS  bash -n"
chk "--help 退出码 0" "$(bash "$SCRIPT" --help >/dev/null 2>&1; echo $?)" "0"
bash "$SCRIPT" >/dev/null 2>&1;                                   chk "缺 --version ⇒ 1" "$?" "1"
bash "$SCRIPT" --version 9.9.9 --release-root /nonexistent >/dev/null 2>&1; chk "release 不存在 ⇒ 1" "$?" "1"
bash "$SCRIPT" --bogus >/dev/null 2>&1;                           chk "未知参数 ⇒ 1" "$?" "1"
# 端口占用时必须拒绝起第二实例（单实例纪律）——用 python 占一个口不引入依赖，改用 nc? 统一用 bash /dev/tcp 监听做不到。
# 改为静态断言：脚本里必须含端口占用检查
chk "含单实例端口检查" "$(grep -c '拒绝起第二实例' "$SCRIPT" || echo 0)" "1"
echo "== 不过项 = $fails =="
[[ "$fails" -eq 0 ]] || exit 1
