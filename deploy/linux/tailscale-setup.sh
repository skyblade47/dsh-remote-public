#!/usr/bin/env bash
# DSH 服务器版 —— Tailscale 接入落地（P5）
#
# 为什么选 Tailscale 而不是域名+TLS：见 DEPLOY-MANUAL.md §1 ——
# 网关自带 TLS/mTLS 两条路，但 **mTLS 真机登录是 P1 的未验项**；Tailscale 提供
# "传输加密 + 设备级准入"，可以走纯 HTTP 把这套未验环节绕开，应用层鉴权（P1）照旧。
#
# 做什么（幂等，可重复跑）：
#   1) 装 Tailscale（走官方 apt 源，**显式**加 keyring 与源，不用 curl | sh）
#   2) 启动 tailscaled 并设为开机自启
#   3) tailscale up（无 authkey 时打印登录链接，人工点一下）
#   4) 配 ufw：只放行 SSH 与 tailscale0，其余入站一律拒绝
#   5) 打印 tailnet IPv4 / MagicDNS 名 / 客户端该访问的 URL
#      （带 --ssh 时一并开启 Tailscale SSH：免私钥、免固定出口 IP 的漫游登录）
#
# 用法（需 root）：
#   sudo deploy/linux/tailscale-setup.sh
#   sudo deploy/linux/tailscale-setup.sh --hostname <server>
#   sudo deploy/linux/tailscale-setup.sh --authkey tskey-xxxx      # 无人值守
#   sudo deploy/linux/tailscale-setup.sh --ssh                     # 开 Tailscale SSH
#   sudo deploy/linux/tailscale-setup.sh --no-ufw                  # 只装不配防火墙
set -uo pipefail

HOSTNAME_ARG=""
AUTHKEY=""
DO_UFW=1
DO_SSH=0
SSH_PORT=22
GATEWAY_PORT="${DSH_GATEWAY_PORT:-8080}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --hostname)   HOSTNAME_ARG="$2"; shift 2 ;;
    --authkey)    AUTHKEY="$2"; shift 2 ;;
    --ssh)        DO_SSH=1; shift ;;
    --ssh-port)   SSH_PORT="$2"; shift 2 ;;
    --no-ufw)     DO_UFW=0; shift ;;
    -h|--help)    sed -n '2,21p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "未知参数：$1（用 --help 看用法）" >&2; exit 2 ;;
  esac
done

[[ "$(id -u)" == "0" ]] || { echo "需要 root：sudo $0" >&2; exit 1; }

say() { printf '\n===== %s =====\n' "$*"; }

# ---- 1) 安装 ----
say "1) 安装 Tailscale（官方 apt 源）"
if command -v tailscale >/dev/null 2>&1; then
  echo "  已安装：$(tailscale version | head -1)"
else
  . /etc/os-release
  CODENAME="${VERSION_CODENAME:-noble}"
  echo "  发行版代号：$CODENAME"
  install -m 0755 -d /usr/share/keyrings
  curl -fsSL "https://pkgs.tailscale.com/stable/ubuntu/${CODENAME}.noarmor.gpg" \
    -o /usr/share/keyrings/tailscale-archive-keyring.gpg \
    || { echo "  ❌ 取 keyring 失败（检查出网）" >&2; exit 1; }
  curl -fsSL "https://pkgs.tailscale.com/stable/ubuntu/${CODENAME}.tailscale-keyring.list" \
    -o /etc/apt/sources.list.d/tailscale.list \
    || { echo "  ❌ 取源列表失败（检查出网）" >&2; exit 1; }
  apt-get update -qq && apt-get install -y tailscale \
    || { echo "  ❌ 安装失败" >&2; exit 1; }
  echo "  已安装：$(tailscale version | head -1)"
fi

# ---- 2) 服务 ----
say "2) 启动 tailscaled（开机自启）"
systemctl enable --now tailscaled
sleep 2
echo "  tailscaled: $(systemctl is-active tailscaled)"

# ---- 3) 入网 ----
say "3) 加入 tailnet"
if tailscale ip -4 >/dev/null 2>&1 && [[ -n "$(tailscale ip -4 2>/dev/null)" ]]; then
  echo "  已入网，tailnet IPv4 = $(tailscale ip -4)"
  # 已入网时补开 --ssh：up 在已认证状态下只应用偏好，不会再弹登录链接
  if [[ "$DO_SSH" == "1" ]]; then
    tailscale up --ssh >/dev/null && echo "  已开启 Tailscale SSH（免私钥登录）"
  fi
else
  ARGS=(up)
  [[ -n "$HOSTNAME_ARG" ]] && ARGS+=(--hostname "$HOSTNAME_ARG")
  [[ -n "$AUTHKEY" ]] && ARGS+=(--authkey "$AUTHKEY")
  [[ "$DO_SSH" == "1" ]] && ARGS+=(--ssh)
  echo "  执行：tailscale ${ARGS[*]}"
  tailscale "${ARGS[@]}" || { echo "  ❌ 入网失败（无 authkey 时需按提示在浏览器点登录链接）" >&2; exit 1; }
fi

# ---- 4) 防火墙 ----
if [[ "$DO_UFW" == "1" ]]; then
  say "4) 配 ufw（只放行 SSH 与 tailscale0）"
  if ! command -v ufw >/dev/null 2>&1; then
    echo "  ufw 未安装，跳过（可 apt-get install -y ufw 后重跑本脚本）"
  else
    # 先允许 SSH，再开 ufw —— 顺序反了会把自己关在门外
    ufw allow "${SSH_PORT}/tcp" >/dev/null
    ufw allow 41641/udp >/dev/null          # Tailscale 直连；不放通则退化为 DERP 中继
    ufw allow in on tailscale0 >/dev/null   # tailnet 流量从该接口进来
    ufw default deny incoming >/dev/null
    ufw default allow outgoing >/dev/null
    ufw --force enable >/dev/null
    echo "  --- 规则："
    ufw status | sed 's/^/    /'
    echo "  ⚠️ 网关端口 ${GATEWAY_PORT} 不单独放行：tailnet 流量已由 'in on tailscale0' 覆盖，"
    echo "     且它**不应**对公网可达（安全组里也不要开）。"
  fi
else
  say "4) 跳过 ufw（--no-ufw）"
fi

# ---- 5) 收尾信息 ----
say "5) 客户端该用什么地址"
IPV4="$(tailscale ip -4 2>/dev/null || true)"
DNSNAME="$(tailscale status --json 2>/dev/null | grep -oE '"DNSName":"[^"]+"' | head -1 | cut -d'"' -f4 | sed 's/\.$//')"
echo "  tailnet IPv4 : ${IPV4:-（取不到）}"
echo "  MagicDNS 名  : ${DNSNAME:-（未启用 MagicDNS，可用 IPv4）}"
echo
echo "  在**已加入同一 tailnet 的客户端**上打开："
echo "    http://${DNSNAME:-$IPV4}:${GATEWAY_PORT}/"
echo
echo "  若打不开，依次检查：① 客户端是否在同一 tailnet ② 服务端 /etc/dsh-remote.env 里"
echo "  DSH_GATEWAY_HOST 是否已设为 0.0.0.0 ③ sudo ufw status 是否有 'in on tailscale0'"
echo "  ④ 云控制台安全组是否**没有**开 8080（要的就是不开，走 tailnet 进）"
