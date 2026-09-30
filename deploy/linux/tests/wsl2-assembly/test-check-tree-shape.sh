#!/usr/bin/env bash
# Task 3 判据：check-tree-shape.sh 在**假树**上能正确判 PASS/FAIL，且"扁平"那条真的会 FAIL
#   用法：bash deploy/linux/tests/wsl2-assembly/test-check-tree-shape.sh
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
SCRIPT="$REPO_ROOT/deploy/linux/check-tree-shape.sh"
ROOT="$(mktemp -d)"
VER="0.1.5-rc.1"
fails=0
chk() { if [[ "$2" == "$3" ]]; then printf '  PASS  %s\n' "$1"; else printf '  FAIL  %s：期望 %s 实际 %s\n' "$1" "$3" "$2"; fails=$((fails + 1)); fi; }

make_fake() {
  rm -rf "$ROOT"
  DSH="$ROOT/$VER/kernel/lib/node_modules/@deepseek-ai/dsh"
  mkdir -p "$DSH/node_modules/@deepseek-ai/dsh-base/node_modules"
  printf '{"name":"@deepseek-ai/dsh","version":"%s"}\n' "$VER" > "$DSH/package.json"
  # 顶层非隐藏项 = @deepseek-ai / a / b / c ⇒ 4（.bin 不计）
  mkdir -p "$DSH/node_modules/a" "$DSH/node_modules/b" "$DSH/node_modules/c" "$DSH/node_modules/.bin"
  mkdir -p "$ROOT/$VER/plugins/version-radar" "$ROOT/$VER/plugins/taskkit"
  # T-8 宿主包接线（F1）：相对链必须解析到**本 release 内**（真源见 kernel-release.sh 第 4b 步）
  mkdir -p "$DSH/node_modules/@deepseek-ai/dsh-tools"
  printf '{"name":"@deepseek-ai/dsh-tools","version":"%s"}\n' "$VER" > "$DSH/node_modules/@deepseek-ai/dsh-tools/package.json"
  mkdir -p "$ROOT/$VER/plugins/node_modules/@deepseek-ai"
  ln -sfn ../../../kernel/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-tools \
          "$ROOT/$VER/plugins/node_modules/@deepseek-ai/dsh-tools"
  # T-9 lockfile 与 pnpm-workspace.yaml 成对（F3）：两边 overrides 必须逐字一致
  mkdir -p "$ROOT/$VER/profile"
  cat > "$ROOT/$VER/profile/pnpm-workspace.yaml" <<'YML'
packages: []
overrides:
  '@deepseek-ai/dsh-settings': 0.1.6-alpha.2
onlyBuiltDependencies: []
YML
  cat > "$ROOT/$VER/profile/pnpm-lock.yaml" <<'YML'
lockfileVersion: '9.0'
overrides:
  '@deepseek-ai/dsh-settings': 0.1.6-alpha.2
YML
  TD="$ROOT/$VER/profile/node_modules"; mkdir -p "$TD/.pnpm/e1" "$TD/.pnpm/e2"
  mk_third() { mkdir -p "$TD/$1"; printf '{"name":"%s","version":"%s"}\n' "$1" "$2" > "$TD/$1/package.json"; }
  mk_third "@huanlin/dsh-plugin-better-locale" "0.4.1"
  mk_third "@nanmicoder/dsh-agent-teams" "0.1.20"
  mk_third "dsh-better-sidebar" "0.19.1"
  mk_third "dshmarket" "1.47.0"
}
COMMON=(--version "$VER" --release-root "$ROOT" --expect-top 4 \
        --expect-size-mib 1 --size-tol-pct 200 --expect-plugins 2 --expect-pnpm-entries 2)

bash -n "$SCRIPT" || { echo "  FAIL  语法不过"; exit 1; }; echo "  PASS  bash -n"

make_fake
bash "$SCRIPT" "${COMMON[@]}" >"$ROOT/clean.out" 2>&1; rc=$?
chk "干净假树 exit 0" "$rc" "0"
chk "干净假树 T-4 PASS" "$(grep -c 'T-4 *PASS' "$ROOT/clean.out" || echo 0)" "1"
chk "干净假树 T-8 PASS" "$(grep -c 'T-8 *PASS' "$ROOT/clean.out" || echo 0)" "1"
chk "干净假树 T-9 PASS" "$(grep -c 'T-9 *PASS' "$ROOT/clean.out" || echo 0)" "1"

# 故意破坏"扁平"：造出嵌套 @deepseek-ai
mkdir -p "$ROOT/$VER/kernel/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-base/node_modules/@deepseek-ai/dsh-sandbox-local"
bash "$SCRIPT" "${COMMON[@]}" >"$ROOT/bad.out" 2>&1; rc=$?
chk "嵌套后 exit 2" "$rc" "2"
chk "嵌套后 T-4 FAIL" "$(grep -c 'T-4 *FAIL' "$ROOT/bad.out" || echo 0)" "1"

# 人工裁定 ⇒ 降级为 DIFF 且 exit 0
bash "$SCRIPT" "${COMMON[@]}" --accept-diff T-4 >"$ROOT/acc.out" 2>&1; rc=$?
chk "裁定后 exit 0" "$rc" "0"
chk "裁定后打印 DIFF" "$(grep -c 'T-4 *DIFF' "$ROOT/acc.out" || echo 0)" "1"

# 缺 version-radar ⇒ T-5 FAIL
make_fake; rmdir "$ROOT/$VER/plugins/version-radar"
bash "$SCRIPT" "${COMMON[@]}" >"$ROOT/nvr.out" 2>&1; rc=$?
chk "缺 version-radar exit 2" "$rc" "2"
chk "T-5 指出缺 version-radar" "$(grep -c '缺 version-radar' "$ROOT/nvr.out" || echo 0)" "1"

# 宿主包接线指向 release 之外（版本混用）⇒ T-8 FAIL（这条是 T-8 存在的理由：
#   服务器 live 侧实测那条链正指向旧全局安装 /usr/local/node-v22.19.0-linux-x64/...）
make_fake
mkdir -p "$ROOT/outside-dsh-tools"
printf '{"name":"@deepseek-ai/dsh-tools","version":"0.0.0"}\n' > "$ROOT/outside-dsh-tools/package.json"
ln -sfn "$ROOT/outside-dsh-tools" "$ROOT/$VER/plugins/node_modules/@deepseek-ai/dsh-tools"
bash "$SCRIPT" "${COMMON[@]}" >"$ROOT/wire.out" 2>&1; rc=$?
chk "接线越界 exit 2" "$rc" "2"
chk "接线越界 T-8 FAIL" "$(grep -c 'T-8 *FAIL' "$ROOT/wire.out" || echo 0)" "1"

# --emit-fixture 必须给出绝对路径 + 权限步骤
make_fake
bash "$SCRIPT" "${COMMON[@]}" --emit-fixture >"$ROOT/fix.out" 2>&1
chk "emit-fixture 有绝对路径" "$(grep -c "release 绝对路径 : $ROOT/$VER" "$ROOT/fix.out" || echo 0)" "1"
chk "emit-fixture 有 chmod 步骤" "$(grep -c 'chmod -R u=rwX,go=rX' "$ROOT/fix.out" || echo 0)" "1"

echo "== 不过项 = $fails =="
[[ "$fails" -eq 0 ]] || exit 1
