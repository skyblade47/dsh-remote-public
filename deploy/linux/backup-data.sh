#!/usr/bin/env bash
# ============================================================================
# 使用数据备份（服务端更新前后用）
#
# 目的：把**不可重建的使用数据**打成包，落到 `/root/dsh-backups/data-<时间戳>/`，
#       再由本机 `tools/data-backup.ps1 -Action Pull` 拉到本地留存。
#
# 🔴 三条设计纪律（都在实现里）：
#   ① **只读源**：全程对 `$DSH_HOME` / `$DSH_WORKSPACE` 只读（不 move、不删、不加 --remove-files）；
#   ② **默认不动机器**：不加 `--stop` 就是热备（不停内核/网关）；要严格一致再加 `--stop`；
#   ③ **默认不删旧备份**：轮转要显式 `--prune`（备份是最后一道保险，不该被一个手滑的默认值删掉）。
#
# 用法（服务器上，root）：
#   bash deploy/linux/backup-data.sh                     # 热备「使用数据」
#   bash deploy/linux/backup-data.sh --stop              # 先停内核+网关再备（一致性最好，几秒）
#   bash deploy/linux/backup-data.sh --full              # 连 profiles/ 一起（≈1.5 GB，供整机回放）
#   bash deploy/linux/backup-data.sh --keep 5 --prune    # 保留最近 5 份，更老的删掉
#   bash deploy/linux/backup-data.sh --dry-run           # 只打印将要做什么，不写盘
#
# 环境变量（都有默认值，便于非默认部署）：
#   DSH_HOME（默认 /srv/dsh-home）· DSH_WORKSPACE_ROOT（默认 /srv/dsh-workspace）
#   DSH_BACKUP_ROOT（默认 /root/dsh-backups）
#
# 退出码：0 成功；1 备份过程出错；2 用法/环境错误。
# ============================================================================
set -euo pipefail

DSH_HOME_DIR="${DSH_HOME:-/srv/dsh-home}"
DSH_WS_DIR="${DSH_WORKSPACE_ROOT:-/srv/dsh-workspace}"
DEST_ROOT="${DSH_BACKUP_ROOT:-/root/dsh-backups}"

FULL=0
STOP=0
PRUNE=0
DRY=0
KEEP=5

while [ $# -gt 0 ]; do
  case "$1" in
    --full) FULL=1 ;;
    --stop) STOP=1 ;;
    --prune) PRUNE=1 ;;
    --dry-run) DRY=1 ;;
    --keep) shift; KEEP="${1:-5}" ;;
    --keep=*) KEEP="${1#--keep=}" ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "用法错误：未知参数 $1（--help 看用法）" >&2; exit 2 ;;
  esac
  shift
done

[ -d "$DSH_HOME_DIR" ] || { echo "找不到 DSH_HOME：$DSH_HOME_DIR" >&2; exit 2; }
[ -d "$DSH_WS_DIR" ] || { echo "找不到工作区：$DSH_WS_DIR" >&2; exit 2; }

STAMP="$(date +%Y%m%d-%H%M%S)"
DEST="$DEST_ROOT/data-$STAMP"
MODE=$([ "$FULL" = 1 ] && echo full || echo data)

# 用 pigz 加速（有就用，没有退回 gzip）
if command -v pigz >/dev/null 2>&1; then TARZ="tar -I pigz -cf"; else TARZ="tar -czf"; fi

say() { printf '%s\n' "$*"; }

say "=== 使用数据备份 · $STAMP ==="
say "模式   : $MODE$([ "$STOP" = 1 ] && echo '（停写）' || echo '（热备，不停服务）')"
say "DSH_HOME     : $DSH_HOME_DIR"
say "工作区       : $DSH_WS_DIR"
say "落点         : $DEST"
say ""

if [ "$DRY" = 1 ]; then
  say "[dry-run] 不写盘。将要执行："
  say "  mkdir -p $DEST"
  say "  打 dsh-home-data.tar.gz ：$DSH_HOME_DIR 下的 会话/配置/预设/存储"
  say "  打 dsh-workspace-data.tar.gz ：$DSH_WS_DIR 去掉 社区插件 与 剪枝快照_*$([ "$FULL" = 1 ] && echo '（--full：不去掉）')"
  say "  写 MANIFEST.txt + SHA256SUMS"
  exit 0
fi

mkdir -p "$DEST"

# ── 停写（可选）：只停**本次真在跑**的单元，结束时按原状态恢复 ────────────────
STOPPED=""
restore_services() {
  for u in $STOPPED; do
    say "  恢复：systemctl start $u"
    systemctl start "$u" || say "  ⚠️ $u 启动失败，请手动检查"
  done
}
if [ "$STOP" = 1 ]; then
  for u in dsh-remote dsh-kernel; do
    if systemctl is-active --quiet "$u"; then
      say "停写：systemctl stop $u"
      systemctl stop "$u"
      STOPPED="$u $STOPPED"
    fi
  done
  trap 'restore_services' EXIT
  say ""
fi

# ── 包 1：DSH_HOME 的使用数据（逐项，缺的自动跳过）────────────────────────────
HOME_ITEMS="sessions storages .agent-presets .credentials.yaml settings.yaml hotplug-manifest.yml session-owners.json task-board users .anonymous-user-id"
if [ "$FULL" = 1 ]; then HOME_ITEMS="$HOME_ITEMS profiles"; fi
EXIST=""
MISSING=""
for it in $HOME_ITEMS; do
  if [ -e "$DSH_HOME_DIR/$it" ]; then EXIST="$EXIST $it"; else MISSING="$MISSING $it"; fi
done
say "包 1/2 dsh-home-data.tar.gz  收录：$EXIST"
[ -n "$MISSING" ] && say "        （本机不存在、跳过：$MISSING）"
# shellcheck disable=SC2086
$TARZ "$DEST/dsh-home-data.tar.gz" -C "$DSH_HOME_DIR" $EXIST

# ── 包 2：工作区（整棵树扣掉可重建/重复的部分）───────────────────────────────
WS_EXCLUDES=()
if [ "$FULL" != 1 ]; then
  # 社区插件可从上游重下；剪枝快照是同一份数据的多个时间副本 ⇒ 都不进数据备份
  WS_EXCLUDES+=(--exclude='DSH工具/社区插件')
  WS_EXCLUDES+=(--exclude='DSH工具/剪枝快照_*')
fi
say "包 2/2 dsh-workspace-data.tar.gz  收录：整棵工作区$([ "$FULL" != 1 ] && echo '（排除：DSH工具/社区插件、DSH工具/剪枝快照_*）')"
if [ "${#WS_EXCLUDES[@]}" -gt 0 ]; then
  $TARZ "$DEST/dsh-workspace-data.tar.gz" -C "$DSH_WS_DIR" "${WS_EXCLUDES[@]}" .
else
  $TARZ "$DEST/dsh-workspace-data.tar.gz" -C "$DSH_WS_DIR" .
fi

# ── 台账：MANIFEST + SHA256SUMS（本机拉取后据此校验）─────────────────────────
say ""
say "计算校验值…"
( cd "$DEST" && sha256sum ./*.tar.gz > SHA256SUMS )

{
  echo "时间戳 : $STAMP"
  echo "时刻   : $(date '+%Y-%m-%d %H:%M:%S %Z')"
  echo "主机   : $(hostname)"
  echo "口径   : $MODE$([ "$STOP" = 1 ] && echo ' + 停写' || echo ' + 热备')"
  echo "DSH_HOME     : $DSH_HOME_DIR"
  echo "工作区       : $DSH_WS_DIR"
  echo "收录（home） :$EXIST"
  [ -n "$MISSING" ] && echo "跳过（home） :$MISSING"
  echo "工作区排除   : $([ "$FULL" != 1 ] && echo 'DSH工具/社区插件、DSH工具/剪枝快照_*' || echo '（无，--full）')"
  echo
  echo "--- 包 ---"
  for f in "$DEST"/*.tar.gz; do
    b=$(basename "$f")
    sz=$(stat -c%s "$f")
    n=$(tar -tzf "$f" | wc -l)
    h=$(sha256sum "$f" | cut -d' ' -f1)
    printf '%-26s %12s 字节  %7s 条目  sha256=%s\n' "$b" "$sz" "$n" "$h"
  done
  echo
  echo "--- 怎么用 ---"
  echo "本机拉取（Windows）："
  echo "  powershell -File tools/data-backup.ps1 -Action Pull -Server <你的 ssh 别名>"
  echo "服务器上还原（⚠️ 会覆盖同名文件，先确认目标）："
  echo "  cd / && tar -xzf $DEST/dsh-home-data.tar.gz -C $DSH_HOME_DIR"
  echo "  cd / && tar -xzf $DEST/dsh-workspace-data.tar.gz -C $DSH_WS_DIR"
  echo "校验："
  echo "  ( cd $DEST && sha256sum -c SHA256SUMS )"
} > "$DEST/MANIFEST.txt"

cat "$DEST/MANIFEST.txt"

# ── 轮转（显式 --prune 才删）─────────────────────────────────────────────────
if [ "$PRUNE" = 1 ]; then
  say ""
  say "轮转：保留最近 $KEEP 份 data-*（更老的删除）"
  # shellcheck disable=SC2012
  ls -1d "$DEST_ROOT"/data-* 2>/dev/null | sort -r | tail -n "+$((KEEP + 1))" | while read -r old; do
    say "  删除 $old"
    rm -rf "$old"
  done
else
  n=$(ls -1d "$DEST_ROOT"/data-* 2>/dev/null | wc -l)
  say ""
  say "现有 data-* 备份 $n 份（默认不删；要轮转加 --keep N --prune）"
fi

say ""
say "✅ 完成：$DEST"
say "   下一步（本机）：powershell -File tools/data-backup.ps1 -Action Pull -Server <ssh 别名>"
