#!/usr/bin/env bash
# 夹具 A 门闸（A-1…A-5）：跑本体、数 OK/NG。
# 🔴 只在 /tmp 下造树；不碰服务器、不碰 E:\ 便携版。
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

out="$(node "$DIR/fixture-a-chain.mjs" 2>&1)"; rc=$?
printf '%s\n' "$out"

ok="$(printf '%s\n' "$out" | grep -c '^OK  ' || true)"
ng="$(printf '%s\n' "$out" | grep -c '^NG  ' || true)"
echo "[fixture-a] OK=$ok NG=$ng rc=$rc"

if [[ "$rc" -eq 0 && "$ng" -eq 0 && "$ok" -ge 8 ]]; then
  echo "✅ 夹具 A 通过（A-1…A-5 全过）"
  exit 0
fi
echo "🔴 夹具 A 未通过" >&2
exit 1
