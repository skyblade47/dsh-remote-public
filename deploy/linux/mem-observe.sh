#!/usr/bin/env bash
# ============================================================================
# mem-observe.sh —— DSH 内核内存「连续一个月观测」采样器
#
# 目的（出处：docs/superpowers/plans/2026-09-26-memory-observation-one-month-plan.md）：
#   把"内存会不会在一年内撞上限"从**短窗口推断**变成**过程变化率外推**。
#   起点已固化在该文档 §1.3（2026-09-26 21:17:34 CST / B′ 生效之后）。
#
# 子命令：
#   sample           采一行（默认；由 systemd timer 每 2 min 调用）
#   analyze [days]   出「极值 + 每日表 + 线性趋势外推」（默认 30 天）
#   install          写 unit/timer 到 /etc/systemd/system 并 enable --now
#   uninstall        停用并删除 unit/timer（**保留数据文件**）
#   status           看 timer 状态 + 数据规模 + 末行
#
# 数据：JSONL，一行一次采样，默认 <DSH_HOME>/logs/mem-observe.jsonl
#   （2 min 一次 ⇒ 约 21,600 行/月 ≈ 5 MB；**不做轮转**）
#
# 纪律：
#   · **全只读**（除写自己那一行 JSONL）—— 不碰内核、不碰会话、不重启任何东西
#   · 不依赖 dsh 原生包、不联网
#   · 输出字段**只增不改**（analyze 依赖字段名稳定）
# ============================================================================
set -uo pipefail

DSH_HOME="${DSH_HOME:-/srv/dsh-home}"
OUT="${MEM_OBSERVE_OUT:-$DSH_HOME/logs/mem-observe.jsonl}"
UNIT="dsh-mem-observe"
SELF="$(readlink -f "$0")"
CG_KERNEL="/sys/fs/cgroup/system.slice/dsh-kernel.service"

usage() {
  cat <<EOF
用法: $(basename "$0") <子命令>

  sample            采一行到 $OUT
  analyze [天数]     分析（默认 30 天）
  install           安装并启动 systemd timer（每 2 min）
  uninstall         停用并删除 unit/timer（保留数据）
  status            状态 + 数据规模 + 末行

环境变量: DSH_HOME（默认 /srv/dsh-home）· MEM_OBSERVE_OUT（覆盖输出路径）
EOF
}

# 读 /proc/<pid>/status 的某个字段（kB 数值）
vm_of() { awk -v k="$1" '$1 == k":" {print $2; exit}' "/proc/$2/status" 2>/dev/null || true; }
cg_of() { cat "$CG_KERNEL/$1" 2>/dev/null || echo '-1'; }

sample() {
  local SESS="$DSH_HOME/sessions"
  local PROJ="$DSH_HOME/storages/session_projcache/sessions"
  local now_cst now_utc epoch

  now_cst=$(date +'%Y-%m-%dT%H:%M:%S%:z')
  now_utc=$(date -u +'%Y-%m-%dT%H:%M:%SZ')
  epoch=$(date +%s)

  # ---- 内核服务 ----
  local KPID KNR KUPT KET
  KPID=$(systemctl show dsh-kernel -p MainPID --value 2>/dev/null); KPID="${KPID:-0}"
  KNR=$(systemctl show dsh-kernel -p NRestarts --value 2>/dev/null); KNR="${KNR:-0}"
  KET=$(systemctl show dsh-kernel -p ActiveEnterTimestamp --value 2>/dev/null)
  if [ "$KPID" != "0" ]; then
    KUPT=$(ps -o etimes= -p "$KPID" 2>/dev/null | tr -d ' '); KUPT="${KUPT:-0}"
  else
    KUPT=0
  fi

  local K_RSS=-1 K_HWM=-1 K_SWAP=-1 K_THR=-1
  if [ "$KPID" != "0" ]; then
    K_RSS=$(vm_of VmRSS "$KPID"); K_RSS="${K_RSS:--1}"
    K_HWM=$(vm_of VmHWM "$KPID"); K_HWM="${K_HWM:--1}"
    K_SWAP=$(vm_of VmSwap "$KPID"); K_SWAP="${K_SWAP:--1}"
    K_THR=$(vm_of Threads "$KPID"); K_THR="${K_THR:--1}"
  fi

  # ---- 网关服务 ----
  local GPID GNR G_RSS
  GPID=$(systemctl show dsh-remote -p MainPID --value 2>/dev/null); GPID="${GPID:-0}"
  GNR=$(systemctl show dsh-remote -p NRestarts --value 2>/dev/null); GNR="${GNR:-0}"
  G_RSS=-1
  [ "$GPID" != "0" ] && { G_RSS=$(vm_of VmRSS "$GPID"); G_RSS="${G_RSS:--1}"; }

  # ---- cgroup 护栏与用量 ----
  local CG_CUR CG_PEAK CG_HIGH CG_MAX
  CG_CUR=$(cg_of memory.current); CG_PEAK=$(cg_of memory.peak)
  CG_HIGH=$(cg_of memory.high); CG_MAX=$(cg_of memory.max)

  # ---- 机器 ----
  local MT MA ST SF SU DISK
  MT=$(awk '/^MemTotal/{print $2}' /proc/meminfo)
  MA=$(awk '/^MemAvailable/{print $2}' /proc/meminfo)
  ST=$(awk '/^SwapTotal/{print $2}' /proc/meminfo)
  SF=$(awk '/^SwapFree/{print $2}' /proc/meminfo)
  SU=$((ST - SF))
  DISK=$(df -P / 2>/dev/null | awk 'NR==2{gsub("%","",$5); print $5+0}'); DISK="${DISK:-0}"

  # ---- 规模 ----
  local SB SD SFL PB
  SB=$(du -sb "$SESS" 2>/dev/null | cut -f1); SB="${SB:-0}"
  SD=$(find "$SESS" -mindepth 1 -type d 2>/dev/null | wc -l)
  SFL=$(find "$SESS" -type f 2>/dev/null | wc -l)
  PB=$(du -sb "$PROJ" 2>/dev/null | cut -f1); PB="${PB:-0}"

  # ---- 活动信号（近 120 s 内被写过的会话文件 + 最近被写的那一个）----
  local thresh RW LS
  thresh=$((epoch - 120))
  RW=$(find "$SESS" -type f -newermt "@$thresh" 2>/dev/null | wc -l)
  LS=$(find "$SESS" -type f -newermt "@$thresh" -printf '%T@ %p\n' 2>/dev/null \
        | sort -rn | head -1 | awk '{n=split($2,a,"/"); print a[n-1]}')
  LS="${LS:--}"

  # ---- 到客户端的已建立连接数（:8080，排除回环）----
  local ESTAB
  ESTAB=$(ss -Htn state established 2>/dev/null \
          | awk '$4 ~ /:8080$/ && $5 !~ /^127\./ {n++} END{print n+0}')

  # ---- OOM 计数：本生命周期 / 滚动 24 h ----
  local OOM_LIFE OOM_24H
  OOM_LIFE=$(journalctl -u dsh-kernel --since "$KET" --no-pager 2>/dev/null | grep -c 'Reached heap limit' || true)
  OOM_24H=$(journalctl -u dsh-kernel --since '-24 hours' --no-pager 2>/dev/null | grep -c 'Reached heap limit' || true)
  OOM_LIFE="${OOM_LIFE:-0}"; OOM_24H="${OOM_24H:-0}"

  # ---- 最大的 3 个会话（按 v3 压缩体积）----
  local TOP3 TOP3SUM
  TOP3=$(find "$SESS" -name 'session.v3.jsonl.zstd' -printf '%s %T@ %p\n' 2>/dev/null \
         | sort -rn | head -3 \
         | awk '{n=split($3,a,"/"); printf "%s|%s|%s;", a[n-1], $1, int($2)}')
  TOP3="${TOP3:-}"
  TOP3SUM=$(printf '%s' "$TOP3" | tr ';' '\n' | awk -F'|' 'NF>=2{s+=$2} END{print s+0}')

  # ---- 落盘（字段**只增不改**）----
  mkdir -p "$(dirname "$OUT")"
  printf '{"ts":"%s","ts_utc":"%s","epoch":%s,"k_pid":%s,"k_restarts":%s,"k_uptime_s":%s,"k_rss_kb":%s,"k_hwm_kb":%s,"k_swap_kb":%s,"k_threads":%s,"cg_cur":%s,"cg_peak":%s,"cg_high":%s,"cg_max":%s,"g_pid":%s,"g_restarts":%s,"g_rss_kb":%s,"mem_total_kb":%s,"mem_avail_kb":%s,"swap_total_kb":%s,"swap_used_kb":%s,"disk_use_pct":%s,"sess_bytes":%s,"sess_dirs":%s,"sess_files":%s,"proj_bytes":%s,"recent_writes":%s,"last_session":"%s","estab_8080":%s,"oom_life":%s,"oom_24h":%s,"top3":"%s","top3_bytes":%s}\n' \
    "$now_cst" "$now_utc" "$epoch" \
    "$KPID" "$KNR" "$KUPT" "$K_RSS" "$K_HWM" "$K_SWAP" "$K_THR" \
    "$CG_CUR" "$CG_PEAK" "$CG_HIGH" "$CG_MAX" \
    "$GPID" "$GNR" "$G_RSS" \
    "$MT" "$MA" "$ST" "$SU" "$DISK" \
    "$SB" "$SD" "$SFL" "$PB" \
    "$RW" "$LS" "$ESTAB" "$OOM_LIFE" "$OOM_24H" "$TOP3" "$TOP3SUM" \
    >> "$OUT"
}

analyze() {
  local days="${1:-30}"
  [ -s "$OUT" ] || { echo "🔴 无数据：$OUT"; exit 1; }
  local prog
  prog=$(mktemp /tmp/mem-observe-analyze.XXXXXX.mjs)
  # ⚠️ trap 里必须**立即展开** $prog（用双引号 + 单引号裹住路径）：
  #    `local prog` 在 EXIT 时已出作用域 ⇒ `set -u` 下会报 "prog: unbound variable"，
  #    且**临时文件不会被清理**（2026-09-27 实测：analyze 尾部报该错）。
  trap "rm -f '$prog'" EXIT
  cat > "$prog" <<'NODE'
import { readFileSync } from 'node:fs'
const [file, daysRaw] = process.argv.slice(2)
const days = Number(daysRaw) || 30
const MiB_B = 1048576 // 字节 → MiB
const MiB_K = 1024    // kB   → MiB
// ⚠️ 坏行（半行/被 kill 打断）**跳过并计数**，不能让它把整个分析炸掉
const rows = []
let skipped = 0
for (const l of readFileSync(file, 'utf8').split(/\r?\n/)) {
  if (!l.trim()) continue
  try { rows.push(JSON.parse(l)) } catch { skipped++ }
}
if (!rows.length) { console.log(`🔴 数据为空（坏行 ${skipped}）`); process.exit(1) }
const first = rows[0], last = rows[rows.length - 1]

console.log('===== 0) 概览 =====')
console.log(`  行数 = ${rows.length}（坏行跳过 ${skipped}）`)
console.log(`  首行 = ${first.ts}    末行 = ${last.ts}`)
console.log(`  跨度 = ${((last.epoch - first.epoch) / 86400).toFixed(2)} 天（期望 ≈ ${days} 天）`)
const gaps = rows.slice(1).map((r, i) => r.epoch - rows[i].epoch).sort((a, b) => a - b)
const p = (q) => (gaps.length ? gaps[Math.min(gaps.length - 1, Math.floor(gaps.length * q))] : '-')
console.log(`  采样间隔(s)：中位 ${p(0.5)}  p90 ${p(0.9)}  最大 ${gaps.length ? gaps[gaps.length - 1] : '-'}（最大 >> 120 ⇒ 有停机/漏采）`)

console.log('\n===== 1) 极值（整段窗口）=====')
const ex = (key, div, label, mode = 'max', unit = 'MiB') => {
  let best = null
  for (const r of rows) {
    const v = Number(r[key])
    if (!Number.isFinite(v) || v < 0) continue
    if (!best || (mode === 'max' ? v > best.v : v < best.v)) best = { v, ts: r.ts }
  }
  const val = best ? (best.v / div).toFixed(1).padStart(9) + ' ' + unit : '      n/a'
  console.log(`  ${(label || key).padEnd(30)} = ${val}   @ ${best ? String(best.ts).slice(11, 19) : '-'}`)
}
ex('cg_cur', MiB_B, 'cgroup current 峰')
ex('cg_peak', MiB_B, 'cgroup peak 峰（本生命周期）')
ex('k_rss_kb', MiB_K, 'VmRSS 峰')
ex('k_hwm_kb', MiB_K, 'VmHWM 峰（高水位）')
ex('k_swap_kb', MiB_K, 'VmSwap 峰')
ex('k_threads', 1, 'Threads 峰', 'max', '个')
ex('mem_avail_kb', MiB_K, 'MemAvailable 最低', 'min')
ex('swap_used_kb', MiB_K, 'swap 已用 峰')
ex('sess_bytes', MiB_B, '会话集 峰')
ex('top3_bytes', MiB_B, '三大会话合计 峰')
const li = rows.filter((r) => Number(r.cg_high) > 0).map((r) => Number(r.cg_high)).pop()
const lm = rows.filter((r) => Number(r.cg_max) > 0).map((r) => Number(r.cg_max)).pop()
if (li) console.log(`  ${'MemoryHigh / MemoryMax'.padEnd(30)} = ${(li / MiB_B).toFixed(1)} / ${(lm / MiB_B).toFixed(1)} MiB`)

console.log('\n===== 2) 每日表 =====')
const byDay = new Map()
for (const r of rows) { const d = r.ts.slice(0, 10); if (!byDay.has(d)) byDay.set(d, []); byDay.get(d).push(r) }
const dayStats = []
console.log('  日期        n   cg_cur_max  cg_peak   rss_max  rss_avg   swap_max  rstΔ oom24h  sess_max(MiB)')
let prevNR = null
for (const [d, rs] of [...byDay].sort()) {
  const mx = (k) => Math.max(...rs.map((r) => Number(r[k]) || 0))
  const avg = (k) => rs.reduce((s, r) => s + (Number(r[k]) || 0), 0) / rs.length
  const nr = Number(rs[rs.length - 1].k_restarts) || 0
  const dNR = prevNR === null ? 0 : nr - prevNR
  prevNR = nr
  const st = { d, n: rs.length, cgMax: mx('cg_cur') / MiB_B, peak: mx('cg_peak') / MiB_B, rssMax: mx('k_rss_kb') / MiB_K, rssAvg: avg('k_rss_kb') / MiB_K, swapMax: mx('k_swap_kb') / MiB_K, dNR, oom: mx('oom_24h'), sess: mx('sess_bytes') / MiB_B }
  dayStats.push(st)
  console.log(`  ${d}  ${String(st.n).padStart(3)}  ${st.cgMax.toFixed(1).padStart(10)}  ${st.peak.toFixed(1).padStart(8)}  ${st.rssMax.toFixed(1).padStart(8)}  ${st.rssAvg.toFixed(1).padStart(8)}  ${st.swapMax.toFixed(1).padStart(9)}  ${String(st.dNR).padStart(4)} ${String(st.oom).padStart(6)}  ${st.sess.toFixed(1).padStart(13)}`)
}

console.log('\n===== 3) 趋势外推（最小二乘，用「每日 rss_max」）=====')
if (dayStats.length < 3) {
  console.log('  ⚠️ 天数 < 3，暂不外推（数据攒够后再跑）')
} else {
  const xs = dayStats.map((_, i) => i)
  const ys = dayStats.map((s) => s.rssMax)
  const n = xs.length
  const sx = xs.reduce((a, b) => a + b, 0), sy = ys.reduce((a, b) => a + b, 0)
  const sxx = xs.reduce((a, b) => a + b * b, 0), sxy = xs.reduce((a, b, i) => a + b * ys[i], 0)
  const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx)
  const inter = (sy - slope * sx) / n
  const y0 = inter, y365 = inter + slope * 365
  console.log(`  斜率 = ${slope >= 0 ? '+' : ''}${slope.toFixed(2)} MiB/天   ⇒ 一年 = ${(slope * 365).toFixed(0)} MiB`)
  console.log(`  今日拟合值 = ${y0.toFixed(1)} MiB        一年后拟合值 = ${y365.toFixed(1)} MiB`)
  if (li) {
    const cap = li / MiB_B
    const daysToCap = slope > 0.01 ? (cap - y0) / slope : Infinity
    console.log(`  MemoryHigh 余量 = ${(cap - y0).toFixed(1)} MiB ⇒ ${Number.isFinite(daysToCap) ? `按此斜率约 ${daysToCap.toFixed(0)} 天触达 MemoryHigh` : '此斜率下不会触达（或在下降）'}`)
    console.log(slope > 0.01 && daysToCap < 365 ? '  🔴 判定：**一年内会触达 MemoryHigh** ⇒ 需提前处置（再抬上限 / 换机器 / 复查会话规模）' : '  ✅ 判定：按当前斜率，一年内不会触达 MemoryHigh')
  }
  const sess = dayStats.map((s) => s.sess)
  const sSlope = n > 2 ? (n * sess.reduce((a, b, i) => a + b * i, 0) - sx * sess.reduce((a, b) => a + b, 0)) / (n * sxx - sx * sx) : 0
  console.log(`  会话集斜率 = ${sSlope >= 0 ? '+' : ''}${(sSlope * 1024).toFixed(1)} MiB/天（会话集在长 ⇒ 内存峰也会跟着长）`)
}

console.log('\n===== 4) 异常计数 =====')
console.log(`  OOM（Reached heap limit，滚动 24 h）峰 = ${Math.max(...rows.map((r) => Number(r.oom_24h) || 0))}`)
console.log(`  内核重启（k_restarts）峰 = ${Math.max(...rows.map((r) => Number(r.k_restarts) || 0))}`)
console.log(`  网关重启（g_restarts）峰 = ${Math.max(...rows.map((r) => Number(r.g_restarts) || 0))}`)
const holes = rows.filter((r) => Number(r.cg_cur) < 0 || Number(r.k_rss_kb) < 0)
console.log(`  读数缺失行 = ${holes.length}    坏行（JSON 解析失败，已跳过）= ${skipped}`)
NODE
  node "$prog" "$OUT" "$days"
}

install_timer() {
  [ "$(id -u)" = "0" ] || { echo "🔴 需 root"; exit 1; }
  local svc="/etc/systemd/system/$UNIT.service"
  local tmr="/etc/systemd/system/$UNIT.timer"
  cat > "$svc" <<EOF
[Unit]
Description=DSH kernel memory observation sampler (one month)

[Service]
Type=oneshot
ExecStart=$SELF sample
Nice=10
IOSchedulingClass=idle
EOF
  cat > "$tmr" <<EOF
[Unit]
Description=Run DSH memory observation sampler every 2 minutes

[Timer]
OnBootSec=3min
OnUnitActiveSec=2min
AccuracySec=15s
Persistent=true
Unit=$UNIT.service

[Install]
WantedBy=timers.target
EOF
  systemctl daemon-reload
  systemctl enable --now "$UNIT.timer" >/dev/null 2>&1
  echo '✅ 已安装并启动 timer'
  systemctl list-timers "$UNIT.timer" --no-pager | head -3
}

uninstall_timer() {
  [ "$(id -u)" = "0" ] || { echo "🔴 需 root"; exit 1; }
  systemctl disable --now "$UNIT.timer" >/dev/null 2>&1
  rm -f "/etc/systemd/system/$UNIT.service" "/etc/systemd/system/$UNIT.timer"
  systemctl daemon-reload
  echo "✅ 已停用并删除 unit/timer（**数据保留**：$OUT）"
}

status() {
  echo "===== timer ====="
  systemctl list-timers "$UNIT.timer" --no-pager 2>/dev/null | head -3 || true
  echo "===== 数据 ====="
  if [ -s "$OUT" ]; then
    echo -n "  行数 = "; wc -l < "$OUT"
    echo -n "  大小 = "; du -h "$OUT" | cut -f1
    echo "  末行 ="; tail -1 "$OUT" | cut -c1-220
  else
    echo "  (无数据：$OUT)"
  fi
}

case "${1:-sample}" in
  sample)    sample ;;
  analyze)   analyze "${2:-30}" ;;
  install)   install_timer ;;
  uninstall) uninstall_timer ;;
  status)    status ;;
  -h|--help|help) usage ;;
  *) usage; exit 2 ;;
esac
