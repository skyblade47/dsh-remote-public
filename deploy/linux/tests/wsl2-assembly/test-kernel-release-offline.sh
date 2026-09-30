#!/usr/bin/env bash
# Task 2 判据：kernel-release.sh install 的 --npm-offline 必须**透传**成 npm 的 --offline
#   做法：把假 npm 放到 PATH 最前，捕获它收到的 argv；再对比"带/不带 --npm-offline"两次
#   🔴 需要 root（kernel-release.sh 里有 require_root）—— 脚本内**自带 root 自检**，非 root 直接 exit 1
#   用法：sudo bash deploy/linux/tests/wsl2-assembly/test-kernel-release-offline.sh
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
KR="$REPO_ROOT/deploy/linux/kernel-release.sh"
TPL="$REPO_ROOT/server/data/templates/profile-web-minimal.package.json"
VER="0.1.5-rc.1"
fails=0
chk() { if [[ "$2" == "$3" ]]; then printf '  PASS  %s（%s）\n' "$1" "$3"; else printf '  FAIL  %s：期望 %s，实际 %s\n' "$1" "$3" "$2"; fails=$((fails + 1)); fi; }

# 🔴 root 自检（2026-09-27 补）：kernel-release.sh 有 require_root ⇒ 非 root 跑会在**调用 npm 之前**就退出，
#   于是"带 --npm-offline"那一路拿到空 argv ⇒ 报一条**误导性 FAIL**（看起来像透传坏了，其实是环境不对）。
#   这里显式拦下，按"环境错误"退 1，与其余脚本的退出码口径一致（1=用法/环境错误）。
if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
  printf '  ABORT  需要 root（kernel-release.sh 内 require_root）\n' >&2
  printf '         用法：sudo bash %s\n' "${BASH_SOURCE[0]}" >&2
  exit 1
fi

# 跑一次 install，回显"假 npm 收到的 argv"（整段，不裁行）
run_case() {
  local extra="$1" T out
  T="$(mktemp -d)"; mkdir -p "$T/bin" "$T/rel"
  cat > "$T/bin/npm" <<'EON'
#!/usr/bin/env bash
# 记录 argv，并按 --prefix 造出 kernel-release.sh 随后要校验的两个文件
printf 'ARGS: %s\n' "$*" >> "$NPM_LOG"
prefix=""; prev=""
for a in "$@"; do [[ "$prev" == "--prefix" ]] && prefix="$a"; prev="$a"; done
if [[ -n "$prefix" ]]; then
  mkdir -p "$prefix/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-tools"
  printf '{"name":"@deepseek-ai/dsh","version":"%s"}\n' "$DSH_FAKE_VER" \
    > "$prefix/lib/node_modules/@deepseek-ai/dsh/package.json"
  printf '{"name":"@deepseek-ai/dsh-tools","version":"0.0.0"}\n' \
    > "$prefix/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-tools/package.json"
fi
exit 0
EON
  chmod +x "$T/bin/npm"
  NPM_LOG="$T/npm.log" DSH_FAKE_VER="$VER" PATH="$T/bin:$PATH" \
    DSH_RELEASE_ROOT="$T/rel" DSH_HOME="$T/home" DSH_SERVICE_USER="$(id -un)" \
    bash "$KR" install "$VER" --npm-before 2026-09-10T12:00:00Z --profile-template "$TPL" $extra \
    >"$T/out.txt" 2>&1
  echo "    install rc=$?"
  cat "$T/npm.log" 2>/dev/null || echo "    （假 npm 未被调用）"
}

echo "-- 不带 --npm-offline（期望 npm argv 里**没有** --offline）--"
A="$(run_case '')"
echo "-- 带 --npm-offline（期望 npm argv 里**有** --offline）--"
B="$(run_case '--npm-offline')"

# ⚠️ 两处 `|| echo 0` 已改为 `|| true`（2026-09-26，Task 2 执行时所修）：
#   `grep -c` 在 **0 命中时既打印 `0` 又退出 1** ⇒ `|| echo 0` 会再追加一个 `0`
#   ⇒ 捕获到 "0\n0" ≠ "0" ⇒ 第一条断言**永远不绿**（与 Task 1 执行记录的 #4 同型）。
chk "默认不含 --offline"    "$(printf '%s' "$A" | grep -c -- '--offline' || true)" "0"
chk "--npm-offline 已透传"  "$(printf '%s' "$B" | grep -c -- '--offline' || true)" "1"
echo "== 不过项 = $fails =="
[[ "$fails" -eq 0 ]] || exit 1
