#!/usr/bin/env bash
# 验证白名单种子落地：目标不存在则写入；**已存在则绝不动它**（运行期增删不能被冲掉）。
# 只 source setup.sh 的函数定义（SETUP_LIB_ONLY=1），不触发任何安装副作用。
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

SEED="$TMP/seed.yml"
DEST="$TMP/hotplug-manifest.yml"
cat > "$SEED" <<'EOF'
version: 1
entries:
  - id: "x"
    path: "@local/x"
    builtin: false
    enabled: true
    config: {}
EOF

SETUP_LIB_ONLY=1 source "$REPO_ROOT/deploy/linux/setup.sh" || true

if ! type -t install_hotplug_seed >/dev/null; then
  echo "FAIL: install_hotplug_seed 未定义"
  exit 1
fi

# 1) 目标不存在 ⇒ 应写入
install_hotplug_seed "$SEED" "$DEST"
[ -f "$DEST" ] || { echo "FAIL: 目标不存在时未写入"; exit 1; }

# 2) 目标已存在**且有条目** ⇒ 必须原样保留
printf 'version: 1\nentries:\n  - id: "user-plugin"\n    path: "@local/user-plugin"\n' > "$DEST"
install_hotplug_seed "$SEED" "$DEST"
grep -q 'user-plugin' "$DEST" || { echo "FAIL: 覆盖了已存在的白名单条目（运行期增删会被冲掉）"; exit 1; }

# 3) 目标已存在但**0 条条目** ⇒ 必须补装种子
#    （实测踩过：留过一个空白名单文件，种子就永远落不下来，日志却说"保留不动"）
printf 'version: 1\nentries:\n' > "$DEST"
install_hotplug_seed "$SEED" "$DEST"
grep -q 'id: "x"' "$DEST" || { echo "FAIL: 空白名单没有被补装种子（会导致一个插件都挂不上）"; exit 1; }

echo "PASS: 白名单种子幂等、不覆盖有条目的文件、空文件会补装"
