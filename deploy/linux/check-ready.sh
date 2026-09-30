#!/usr/bin/env bash
# DSH 服务器版 —— 就绪探针（P5）
#
# 为什么需要它：部署完"看着起来了"和"真的可用"是两件事。本脚本逐项检查**外部可观测的症状**，
# 而不是只 systemctl status 一下就算数。每一项都打印 PASS/FAIL 与**下一步该看什么**。
#
# 检查项：
#   1) Node 版本 ≥ 22.15（内核的 zstd 模块 API 要求；实测生产用 22.19.0）
#   2) 内核在 127.0.0.1:<kernel-port> 上应答（且**只**监听回环）
#   3) 网关在监听（含绑定地址 —— 只绑 127.0.0.1 则外部连不上）
#   4) Tailscale 已入网（装了才检查；未装只提示）
#   5) 两个 systemd 单元 active
#   6) 数据目录与 .credentials.yaml 权限（0600，否则内核会拒绝启动）
#   7) 从内核日志里取出带 token 的访问 URL
#   8) 磁盘与 journal 占用（journal 未设上限时会按盘的 10% 堆积，见部署手册 §11）
#   9) Web 客户端静态资源是否就位（client/ 被 .gitignore 忽略，缺了会**一路绿灯到浏览器 404**）
#  10) 实际挂载了哪些插件（默认是**最小集**，与便携版的全套不同）
#
# 用法：sudo deploy/linux/check-ready.sh
# 退出码：0 = 全部 PASS（允许 WARN）；1 = 有 FAIL
set -uo pipefail

# DSH_HOME 等来自 systemd 的环境文件；手动跑时兜底成默认值
if [[ -f /etc/dsh-remote.env ]]; then
  # shellcheck disable=SC1091
  . /etc/dsh-remote.env
fi
DSH_HOME="${DSH_HOME:-/srv/dsh-home}"
WORKSPACE_ROOT="${DSH_WORKSPACE_ROOT:-/srv/dsh-workspace}"
KERNEL_PORT="${DSH_KERNEL_PORT:-3080}"
GATEWAY_PORT="${DSH_GATEWAY_PORT:-8080}"
GATEWAY_HOST="${DSH_GATEWAY_HOST:-<未设置，默认应为 127.0.0.1>}"

PASS=0; FAIL=0; WARN=0
ok()   { echo "  ✅ PASS  $*"; PASS=$((PASS+1)); }
bad()  { echo "  ❌ FAIL  $*"; FAIL=$((FAIL+1)); }
warn() { echo "  ⚠️  WARN  $*"; WARN=$((WARN+1)); }
say()  { printf '\n===== %s =====\n' "$*"; }

# 取 HTTP 状态码。⚠️ 不要写成 `$(curl ... || echo 000)`：curl **失败时自己也会打印 000**，
# 于是变成 `000000`，`== "000"` 判不中 ⇒ "没在监听"被误报成 PASS（第一版实测踩到）。
# 这里统一：`|| true` 吃掉退出码、空值兜底、再截前 3 位。
http_code() {
  local c
  c="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 "$1" 2>/dev/null || true)"
  c="${c:0:3}"
  echo "${c:-000}"
}

say "0) 环境"
echo "  DSH_HOME        = $DSH_HOME"
echo "  WORKSPACE_ROOT  = $WORKSPACE_ROOT"
echo "  内核端口        = $KERNEL_PORT（应只监听回环）"
echo "  网关端口        = $GATEWAY_PORT，绑定 $GATEWAY_HOST"

say "1) Node 版本（内核要求 ≥ 22.15）"
if command -v node >/dev/null 2>&1; then
  NV="$(node -v)"
  MAJ="${NV#v}"; MAJ="${MAJ%%.*}"; REST="${NV#v*\.}"; MIN="${REST%%.*}"
  if (( MAJ > 22 || (MAJ == 22 && MIN >= 15) )); then
    ok "node $NV"
  else
    bad "node $NV 低于 22.15 ⇒ 内核起不来（zstd 模块 API 缺失）"
  fi
else
  bad "找不到 node（把 npm 全局 bin 加进 PATH，或重跑 setup.sh --install-node）"
fi

say "2) 内核（127.0.0.1:$KERNEL_PORT）"
if command -v ss >/dev/null 2>&1; then
  LISTEN="$(ss -ltn 2>/dev/null | awk -v p=":$KERNEL_PORT" '$4 ~ p {print $4}' | head -3)"
  if [[ -z "$LISTEN" ]]; then
    bad "没有监听 $KERNEL_PORT（journalctl -u dsh-kernel -n 50）"
  elif echo "$LISTEN" | grep -qvE '^(127\.0\.0\.1|\[::1\])'; then
    bad "监听了非回环地址：$LISTEN ⇒ **内核零入站鉴权，必须只绑回环**"
  else
    ok "只监听回环：$LISTEN"
  fi
else
  warn "没有 ss（apt-get install -y iproute2），跳过端口检查"
fi
CODE="$(http_code "http://127.0.0.1:$KERNEL_PORT/")"
if [[ "$CODE" == "000" ]]; then bad "内核端口无应答（curl 000）"; else ok "内核应答 HTTP $CODE"; fi

say "3) 网关（:$GATEWAY_PORT）"
if command -v ss >/dev/null 2>&1; then
  GW="$(ss -ltn 2>/dev/null | awk -v p=":$GATEWAY_PORT" '$4 ~ p {print $4}' | head -3)"
  if [[ -z "$GW" ]]; then
    bad "没有监听 $GATEWAY_PORT（journalctl -u dsh-remote -n 50）"
  else
    ok "监听：$GW"
    if echo "$GW" | grep -qE '^(127\.0\.0\.1|\[::1\])'; then
      warn "只绑了回环 ⇒ 客户端经 tailnet 连不上。把 /etc/dsh-remote.env 的 DSH_GATEWAY_HOST 设为 0.0.0.0"
    fi
  fi
fi
GCODE="$(http_code "http://127.0.0.1:$GATEWAY_PORT/")"
if [[ "$GCODE" == "000" ]]; then
  bad "网关无应答（curl 000）"
else
  ok "网关应答 HTTP $GCODE（未登录时 200 登录页 / 401 都属正常）"
fi

say "4) Tailscale"
if command -v tailscale >/dev/null 2>&1; then
  if tailscale ip -4 >/dev/null 2>&1 && [[ -n "$(tailscale ip -4 2>/dev/null)" ]]; then
    ok "已入网，tailnet IPv4 = $(tailscale ip -4 | head -1)"
    DNSNAME="$(tailscale status --json 2>/dev/null | grep -oE '"DNSName":"[^"]+"' | head -1 | cut -d'"' -f4 | sed 's/\.$//')"
    [[ -n "$DNSNAME" ]] && echo "         客户端地址：http://${DNSNAME}:${GATEWAY_PORT}/" \
                        || echo "         客户端地址：http://$(tailscale ip -4 | head -1):${GATEWAY_PORT}/"
  else
    bad "装了但未入网（sudo tailscale up；或 deploy/linux/tailscale-setup.sh）"
  fi
else
  warn "未装 Tailscale（若用域名+TLS 路线可忽略；见部署手册 §1）"
fi

say "5) systemd 单元"
for u in dsh-kernel dsh-remote; do
  ST="$(systemctl is-active "$u" 2>/dev/null || true)"
  EN="$(systemctl is-enabled "$u" 2>/dev/null || true)"
  if [[ "$ST" == "active" ]]; then ok "$u：active（开机自启=$EN）"
  else bad "$u：$ST（journalctl -u $u -n 50；crash-loop 时先 systemctl reset-failed $u）"; fi
done

# ---- 存活稳定性：**崩溃重启的服务在某一瞬间也会是 active** ----
#
# 为什么必须加这一项：2026-09-23 的干净实例测试里，内核启动约 8 秒后因插件解析失败退出，
# `Restart=always` 让它每 5 秒重启一次。而探针恰好在它"活着的那几秒"采到了样，
# 于是报出 **PASS 15 / WARN 2 / FAIL 0、退出码 0** —— 一路绿灯，十几秒后服务其实已经没了。
# 只采一次样就下"就绪"的结论，会把 crash-loop 判成健康。
echo "  （等 15 秒复核稳定性：一次采样会漏掉 crash-loop）"
sleep 15
for u in dsh-kernel dsh-remote; do
  ST2="$(systemctl is-active "$u" 2>/dev/null || true)"
  NR="$(systemctl show -p NRestarts --value "$u" 2>/dev/null || echo '?')"
  if [[ "$ST2" == "active" ]]; then
    if [[ "$NR" =~ ^[0-9]+$ ]] && (( NR > 0 )); then
      # 判 FAIL 而不是 WARN：NRestarts 只在**自动重启逻辑**生效时增长（手动 systemctl start 会清零），
      # 所以 >0 就意味着"它在没人动的情况下自己挂过"。crash-loop 不该被判成"就绪"。
      bad "$u：仍是 active，但本次启动内**已自动重启过 ${NR} 次** ⇒ 间歇性崩溃（不是健康状态）。看 journalctl -u $u -n 60"
    else
      ok "$u：15 秒后仍 active，且未发生重启（非 crash-loop）"
    fi
  else
    bad "$u：15 秒后变成 $ST2 ⇒ **疑似 crash-loop**。journalctl -u $u -n 60 看真实报错"
  fi
done

say "6) 数据目录与凭据"
[[ -d "$DSH_HOME" ]] && ok "$DSH_HOME 存在" || bad "$DSH_HOME 不存在（重跑 setup.sh）"
[[ -d "$WORKSPACE_ROOT" ]] && ok "$WORKSPACE_ROOT 存在" || bad "$WORKSPACE_ROOT 不存在（重跑 setup.sh）"
CRED="$DSH_HOME/.credentials.yaml"
if [[ -f "$CRED" ]]; then
  MODE="$(stat -c '%a' "$CRED")"
  if [[ "$MODE" == "600" ]]; then ok "$CRED 权限 0600"
  else bad "$CRED 权限 $MODE ⇒ 内核会**拒绝启动**：chmod 600 $CRED"; fi
else
  bad "$CRED 不存在（内核与网关共用；见部署手册 §9）"
fi
[[ -f "$DSH_HOME/settings.yaml" ]] && ok "settings.yaml 存在" || warn "settings.yaml 不存在（可能仍可用默认值）"

say "7) 访问 URL（token 在启动日志里）"
URL="$(journalctl -u dsh-kernel --since '-30 min' --no-pager 2>/dev/null | grep -oE "http://127\.0\.0\.1:$KERNEL_PORT/\?token=[A-Za-z0-9_-]+" | tail -1)"
if [[ -n "$URL" ]]; then ok "内核直连 URL：$URL（仅本机可用；外部走网关 :$GATEWAY_PORT）"
else warn "日志里没找到 token URL（内核启动超过 30 分钟，或日志已轮转）"; fi

say "8) 磁盘与 journal 占用"
# ⚠️ 口径：用 du 而不是 journalctl --disk-usage。实测两者会差近一倍
# （WSL 上 --disk-usage 报 349.6M、du 报 719M；原因未查清）。"占了多少盘"以 du 为准。
if [[ -d /var/log/journal ]]; then
  # ⚠️ 整数 MB。du 失败时 JU 会是空串 —— 必须显式判"取不到"，
  # 不能让它落进 else 分支被当成"很小"（那就是把"读不到"误报成"很健康"）
  JU="$(du -sm /var/log/journal 2>/dev/null | awk '{print $1}')"
  if [[ ! "${JU:-}" =~ ^[0-9]+$ ]]; then
    warn "取不到 /var/log/journal 的占用（du 失败或无权限）⇒ **无法判断，不代表安全**"
  elif (( JU >= 2048 )); then
    bad "journal 实占 ${JU} MB（≥ 2 GB）⇒ 手册 §11：装 drop-in 上限并 journalctl --vacuum-size=500M"
  elif (( JU >= 600 )); then
    warn "journal 实占 ${JU} MB（未设上限时默认可涨到盘的 10%）⇒ 手册 §11"
  else
    ok "journal 实占 ${JU} MB"
  fi
else
  echo "  （/var/log/journal 不存在：journal 可能只驻内存，本项跳过）"
fi

# 上限必须"装了"**且**"生效了"才算数 —— 装了没重启 journald 是很容易漏掉的半成品状态
DROPIN=/etc/systemd/journald.conf.d/50-dsh.conf
if [[ -f "$DROPIN" ]]; then
  EFF="$(systemd-analyze cat-config systemd/journald.conf 2>/dev/null | grep -E '^SystemMaxUse=' | tail -1)"
  if [[ -n "$EFF" ]]; then
    ok "journald 上限已生效（${EFF}）"
  else
    warn "drop-in 已装但**未生效**：sudo systemctl restart systemd-journald"
  fi
else
  warn "无 $DROPIN ⇒ 走 journald 默认上限（盘的 10%，封顶 4 GiB）；重跑 setup.sh 可装"
fi

say "9) Web 客户端静态资源（浏览器打开的就是它）"
# ⚠️ 为什么必须在这里拦：`/client/` 在 .gitignore 里（客户端已拆分为独立仓库
#    skyblade47/dsh-remote-client），**从 git 克隆不会带它**，必须在本机先跑
#    `tools/fetch-client.ps1` 再上传。缺了它**不影响服务启动** —— 内核与网关都照常 active，
#    前面 8 项也全 PASS，但浏览器打开就是 404。这是最容易"一路绿灯直到打开浏览器才发现"的坑。
#
# 默认路径要与网关的判定**一致**：static-routes.js 的 defaultWebRoot() 是
# `<repo>/server/gateway/src/../../..` + client/web ⇒ `<repo>/client/web`。
# 这里从 `<repo>/deploy/linux` 往上两级，得到同一个位置。
WEB_DIR="${DSH_GATEWAY_WEB_DIR:-}"
if [[ -z "$WEB_DIR" ]]; then
  WEB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/client/web"
fi
if [[ -f "$WEB_DIR/index.html" ]]; then
  ok "客户端入口存在：$WEB_DIR/index.html"
  if [[ -f "$WEB_DIR/auth/login.html" ]]; then
    ok "登录页存在：auth/login.html（未登录时 302 的落点）"
  else
    bad "缺 auth/login.html ⇒ 未登录访问会被 302 到一个不存在的页面"
  fi
else
  bad "找不到 $WEB_DIR/index.html ⇒ 浏览器访问只会 404"
  echo "         修法：在**本机**仓库根执行 tools/fetch-client.ps1"
  echo "               （client/ 被 .gitignore 忽略，克隆与 git 检出都不会带它）"
  echo "               然后重新 rsync —— 注意别把 client/ 排除掉"
  echo "               或把 /etc/dsh-remote.env 的 DSH_GATEWAY_WEB_DIR 指到已有客户端目录"
fi

say "10) 插件挂载对照（种子 bundles × 白名单 × 运行态）"
# 判据已更新（2026-09-23）：插件现在走白名单 hotplug-manifest.yml，**不在** profile bundles 里，
# 原先"列出 bundles + 数未挂载的自研插件"会把经白名单加载的插件误报成"未挂载"。
# 现改为调用 server/scripts/report-hotplug-mounts.mjs 做三栏对照并并入本探针计数。
HOTPLUG_REPORT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/server/scripts/report-hotplug-mounts.mjs"
if [[ ! -f "$HOTPLUG_REPORT" ]]; then
  warn "找不到 $HOTPLUG_REPORT（缺脚本，跳过挂载对照）"
elif ! command -v node >/dev/null 2>&1; then
  warn "没有 node，跳过挂载对照"
else
  HOTPLUG_OUT="$(node "$HOTPLUG_REPORT" "$DSH_HOME" 2>&1)"
  HOTPLUG_RC=$?
  printf '%s\n' "$HOTPLUG_OUT" | sed 's/^/  /'
  case "$HOTPLUG_RC" in
    0)
      SUM="$(printf '%s\n' "$HOTPLUG_OUT" | grep -E '^✅ 白名单' | head -1)"; SUM="${SUM#✅ }"
      ok "${SUM:-白名单全部已加载}"
      ;;
    1)
      SUM="$(printf '%s\n' "$HOTPLUG_OUT" | grep -E '^❌ 白名单' | head -1)"; SUM="${SUM#❌ }"
      bad "${SUM:-白名单有 enabled 条目未加载}"
      ;;
    2)
      warn "运行态 API 不可达（内核可能仍在预热：加载 15 个插件约需 25–30 秒）"
      ;;
    *)
      warn "挂载对照脚本异常退出（rc=$HOTPLUG_RC）"
      ;;
  esac
fi

printf '\n===== 汇总：PASS %d / WARN %d / FAIL %d =====\n' "$PASS" "$WARN" "$FAIL"
if [[ "$FAIL" == "0" ]]; then echo "  ✅ 就绪（WARN 项按需处理）"; exit 0; fi
echo "  ❌ 有 FAIL，按上面的提示逐项修"
exit 1
