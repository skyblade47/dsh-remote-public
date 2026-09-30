#!/usr/bin/env bash
# 安全重启 DSH 内核：**先问门闸，再重启**
#
# 为什么需要它（P3-U11）：重启会掐断正在跑的东西（子代理委派、热拔插 reload、未闭合的 turn）。
# 门闸由内核侧的 @local/dsh-adapter 提供（`/adapter/api/resume/gate`），本脚本是它的**唯一正规调用者**。
#
# 策略（用户裁定）：
#   · 轮询到 `safe` 才重启；
#   · 超时 / 取不到判定 / 判定为不安全 ⇒ **只报告、拒绝重启**（`exit` 非 0，不动手）；
#   · `--force` 可跳过门闸，但会**强制写一条审计**（含当时的阻塞项明细）—— 逃生阀必须留：
#     某个会话若有一轮卡死（工具 hang），`openTurns` 会让门闸永久不安全，没有它就成了"永远重启不了"。
#
# ⚠️ 拦不住的洞（如实写在明处）：有人手工 `systemctl restart dsh-kernel` 会绕过本脚本。
#    想真正管住，重启入口就得统一走这里。另：门闸只看**内核进程内**的事，网关等其它进程不在范围内。
#
# 退出码：0=已重启（或本来就没在跑）/ 2=判定不安全，拒绝重启 / 3=没能取得判定（超时/端点不可用）
#         1=用法或环境错误

set -uo pipefail

PORT="${DSH_KERNEL_PORT:-3080}"
UNIT="${DSH_KERNEL_UNIT:-dsh-kernel}"
TIMEOUT=300
INTERVAL=5
FORCE=0
CHECK_ONLY=0
DRY_RUN=0

usage() {
  cat <<'EOF'
用法: restart-kernel.sh [选项]

  --port <n>        内核 HTTP 端口（默认 $DSH_KERNEL_PORT 或 3080）
  --unit <name>     systemd 单元名（默认 $DSH_KERNEL_UNIT 或 dsh-kernel）
  --timeout <sec>   最长等待秒数（默认 300）
  --interval <sec>  轮询间隔秒数（默认 5）
  --check           只判定一次并打印结果，**不等待、不重启**（退出码同下）
  --dry-run         等待并判定，但不真的重启（safe 时也只打印）
  --force           跳过门闸直接重启（会写一条审计留痕）
  -h, --help        显示本帮助

退出码: 0=已重启/无需重启   2=判定不安全，拒绝重启   3=未能取得判定（超时/端点不可用）   1=用法或环境错误
EOF
}

log() { printf '[restart-kernel] %s\n' "$*"; }
die() { printf '[restart-kernel] 错误: %s\n' "$*" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --port) PORT="${2:-}"; shift 2 ;;
    --unit) UNIT="${2:-}"; shift 2 ;;
    --timeout) TIMEOUT="${2:-}"; shift 2 ;;
    --interval) INTERVAL="${2:-}"; shift 2 ;;
    --check) CHECK_ONLY=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --force) FORCE=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "未知参数: $1（--help 看用法）" ;;
  esac
done

[[ "$PORT" =~ ^[0-9]+$ ]] || die "--port 必须是数字，收到 '$PORT'"
[[ "$TIMEOUT" =~ ^[0-9]+$ ]] || die "--timeout 必须是数字，收到 '$TIMEOUT'"
[[ "$INTERVAL" =~ ^[0-9]+$ ]] || die "--interval 必须是数字，收到 '$INTERVAL'"
command -v curl >/dev/null 2>&1 || die "需要 curl（用于查询门闸端点）"

URL="http://127.0.0.1:${PORT}/adapter/api/resume/gate"
HAVE_SYSTEMCTL=0
command -v systemctl >/dev/null 2>&1 && HAVE_SYSTEMCTL=1

# 取一个 JSON 布尔/字符串字段（响应是 JSON.stringify(obj, 2) 的缩进格式，故按行匹配足够稳）
json_field() {
  # $1 = 字段名；stdin = JSON
  tr -d ' \t' | grep -o "\"$1\":[^,}]*" | head -1 | sed -E "s/^\"$1\"://"
}

# 查一次门闸：把 body 写进 $GATE_BODY / 状态码写进 $GATE_CODE
# 只有 **200** 才算"拿到判定"；503/500 属于"取不到判定"（门闸不可用或求值出错），
# 与"判定为不安全"是两件事 —— 但两者都**不放行重启**（fail-closed）。
GATE_BODY=""
GATE_CODE=""
query_gate() {
  local out
  out="$(curl -sS --max-time 10 -w $'\n%{http_code}' "$URL" 2>/dev/null)" || return 1
  GATE_CODE="$(printf '%s' "$out" | tail -n1)"
  GATE_BODY="$(printf '%s' "$out" | sed '$d')"
  [[ "$GATE_CODE" == "200" ]] || return 1
  return 0
}

# 内核没在跑 ⇒ 没有"在飞"可丢，门闸无意义
kernel_active() {
  [[ "$HAVE_SYSTEMCTL" == "1" ]] || return 1
  systemctl is-active --quiet "$UNIT"
}

do_restart() {
  if [[ "$HAVE_SYSTEMCTL" != "1" ]]; then
    log "没有 systemctl，无法重启。请手动重启单元 '$UNIT'。"
    return 1
  fi
  if [[ "$DRY_RUN" == "1" ]]; then
    log "--dry-run：不执行 systemctl restart $UNIT"
    return 0
  fi
  log "执行 systemctl restart $UNIT"
  systemctl restart "$UNIT" || die "systemctl restart $UNIT 失败"
  sleep 3
  if systemctl is-active --quiet "$UNIT"; then
    log "重启完成，单元 $UNIT 处于 active ✅"
  else
    log "⚠️ 重启后单元 $UNIT 不是 active，请检查 journalctl -u $UNIT"
  fi
  return 0
}

report_blockers() {
  printf '%s\n' "$GATE_BODY" >&2
}

# ---- --force：跳过门闸，但必须留痕 ----
if [[ "$FORCE" == "1" ]]; then
  log "⚠️ --force：跳过门闸。若内核在跑，先记一条审计留痕（best-effort）"
  if kernel_active; then
    if curl -sS --max-time 10 -X POST -H 'content-type: application/json' \
        -d '{"op":"force","reason":"--force from restart-kernel.sh","by":"restart-kernel.sh"}' \
        "$URL" >/dev/null 2>&1; then
      log "已写入门闸审计（resume.gate_force）"
    else
      log "⚠️ 写审计失败（不影响重启）：门闸端点不可达"
    fi
  else
    log "内核未运行 ⇒ 无在飞工作可丢，无需审计"
  fi
  do_restart
  exit $?
fi

# ---- 内核没在跑：直接（重）启 ----
if [[ "$HAVE_SYSTEMCTL" == "1" ]] && ! kernel_active; then
  log "单元 $UNIT 未运行 ⇒ 没有在飞工作可丢，跳过门闸"
  do_restart
  exit $?
fi

# ---- 正常路径：轮询门闸 ----
DEADLINE=$(( $(date +%s) + TIMEOUT ))
LAST_REASON=""
attempt=0
while :; do
  attempt=$((attempt + 1))
  if query_gate; then
    safe_val="$(printf '%s' "$GATE_BODY" | json_field safe)"
    ok_val="$(printf '%s' "$GATE_BODY" | json_field ok)"
    reason_val="$(printf '%s' "$GATE_BODY" | json_field reason)"
    if [[ "$safe_val" == "true" ]]; then
      log "门闸判定：safe（第 $attempt 次查询）"
      if [[ "$CHECK_ONLY" == "1" ]]; then exit 0; fi
      do_restart
      exit $?
    fi
    LAST_REASON="safe=$safe_val ok=$ok_val reason=$reason_val"
    if [[ "$CHECK_ONLY" == "1" ]]; then
      log "门闸判定：**不安全**（$LAST_REASON）—— 明细如下："
      report_blockers
      exit 2
    fi
    log "门闸判定：不安全（$LAST_REASON，第 $attempt 次查询），${INTERVAL}s 后重试"
  else
    LAST_REASON="未能取得判定（HTTP ${GATE_CODE:-无响应}，门闸不可用或内核启动中）"
    if [[ "$CHECK_ONLY" == "1" ]]; then
      log "未能取得判定：$LAST_REASON"
      [[ -n "$GATE_BODY" ]] && report_blockers
      exit 3
    fi
    log "$LAST_REASON（第 $attempt 次查询），${INTERVAL}s 后重试"
  fi

  if [[ "$(date +%s)" -ge "$DEADLINE" ]]; then
    log "等待超时（${TIMEOUT}s）—— **拒绝重启**，不代替你做这个决定。"
    log "最后一次判定：$LAST_REASON"
    if [[ -n "$GATE_BODY" ]]; then
      log "最后一次门闸响应："
      report_blockers
    fi
    log "若确认要强行重启，请显式执行：restart-kernel.sh --force（会留下审计）"
    # 区分"判定为不安全"与"根本取不到判定"
    if [[ "$LAST_REASON" == *"safe="* ]]; then exit 2; else exit 3; fi
  fi
  sleep "$INTERVAL"
done
