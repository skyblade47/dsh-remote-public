#!/usr/bin/env bash
# =============================================================================
# smoke-local-wsl2.sh —— 在 WSL2 上对 release 树起一个 headless 实例做冒烟
# =============================================================================
#
# 判据（照整包式设计 §②-4(b) 的 A 栏 / B 栏，阈值按本机调整）：
#   A-1 就绪 < 60 s（判定口径：`/` 开始返回 401 或 200 —— **404 不算就绪**：
#        WSL2 实测启动早期 webserver 已监听但 web-app bundle 还没挂上，`/` 会先给 404）
#   A-2 `Reached heap limit` / `FATAL ERROR` = 0 行
#   A-3 `patch: (entry|insert|name)` 告警**无输出**
#   A-4 树扁平（== check-tree-shape.sh 的 T-4）
#   A-5 插件全挂（WSL2 无网关 ⇒ 用 adapter 日志 + hotplug 审计代替 report-hotplug-mounts）
#   A-6 带 token cookie 的 `curl /` == 200（⚠️ **裸 `/` 是 401**：token 必需；
#        判据必须带 cookie，否则会把"正常鉴权"误判成"没起"）
#   B-1 历史会话能打开（信封式 RPC：POST /api/session/list → /api/session/page）
#   B-3 工作区读写
#   B-2 新会话跑通一轮 —— 🔴 **需要模型 API key**；不给 `--run-turn` 或没有凭据 ⇒
#       降级为 B-1+B-3 并显式打印"未跑真实对话轮次"
#
# 🔴 纪律：单实例、端口 3180、独立 DSH_HOME、**跑完即停**（不与其它重活并行）。
#
# 用法：
#   sudo bash deploy/linux/smoke-local-wsl2.sh --version 0.1.5-rc.1
#   sudo bash deploy/linux/smoke-local-wsl2.sh --version 0.1.5-rc.1 --manifest /path/hotplug-manifest.yml
#   sudo bash deploy/linux/smoke-local-wsl2.sh --version 0.1.5-rc.1 --keep
#
# 退出码：0=A 栏全过（B 栏按口径执行并标注） 2=A 栏有 FAIL

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SHAPE="$REPO_ROOT/deploy/linux/check-tree-shape.sh"
HOTPLUG_SEED="$REPO_ROOT/server/data/templates/hotplug-manifest.seed.yml"

VERSION=""
RELEASE_ROOT="${DSH_RELEASE_ROOT:-/usr/local/dsh-release}"
PORT=3180
TEST_ROOT="${DSH_SMOKE_ROOT:-$HOME/dsh-local-test}"
DSH_HOME="$TEST_ROOT/home"
WORKSPACE="$TEST_ROOT/workspace"
READY_TIMEOUT=60
RUN_TURN=0
KEEP=0
WIRE_PLUGINS=1
MANIFEST=""
TEST_ROOT_FROM_ARG=0   # 1 = 用户显式给了 --test-root（⇒ 不需要 $HOME）

log()  { printf '\033[36m[smoke]\033[0m %s\n' "$*"; }
err()  { printf '\033[31m[smoke]\033[0m %s\n' "$*" >&2; }

# 白名单条目数（`grep -c` 在 0 命中时既打印 "0" 又返回非 0 ⇒ 必须单独兜底）
count_manifest_ids() {
  local n=0
  [[ -f "$1" ]] && n="$(grep -c '^[[:space:]]*- id:' "$1" 2>/dev/null)" || n=0
  [[ "$n" =~ ^[0-9]+$ ]] || n=0
  printf '%s' "$n"
}

usage() {
  cat <<'EOF'
用法: smoke-local-wsl2.sh --version <ver> [选项]

  --version <ver>       目标版本（必填）
  --release-root <dir>  release 根（默认 /usr/local/dsh-release）
  --port <n>            监听端口（默认 3180）
  --test-root <dir>     本次冒烟的工作根（默认 $HOME/dsh-local-test；DSH_HOME = <it>/home）
  --no-wire-plugins     不把 13 个自研插件接进独立 DSH_HOME（⇒ A-5 记 N/A，不判失败）
  --manifest <file>     白名单夹具（hotplug-manifest.yml）；给了才可能判"13 插件全挂"
  --run-turn            跑 B-2（**需要 .credentials.yaml 里有可用模型 key**）
  --keep                跑完不停实例（默认**停**；单实例纪律）
  -h, --help            显示本帮助

退出码: 0=A 栏全过  2=A 栏有 FAIL
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --version)          VERSION="${2:-}"; shift 2 ;;
    --release-root)     RELEASE_ROOT="${2%/}"; shift 2 ;;
    --port)             PORT="${2:-}"; shift 2 ;;
    --test-root)        TEST_ROOT="${2%/}"; TEST_ROOT_FROM_ARG=1; shift 2; DSH_HOME="$TEST_ROOT/home"; WORKSPACE="$TEST_ROOT/workspace" ;;
    --no-wire-plugins)  WIRE_PLUGINS=0; shift ;;
    --manifest)         MANIFEST="${2:-}"; shift 2 ;;
    --run-turn)         RUN_TURN=1; shift ;;
    --keep)             KEEP=1; shift ;;
    -h|--help)          usage; exit 0 ;;
    *) err "未知参数：$1"; usage >&2; exit 1 ;;
  esac
done
[[ -n "$VERSION" ]] || { err "--version 必填"; usage >&2; exit 1; }

# ---- $HOME 校验（S3 / B4）：fail-fast，放在**参数解析之后、动作之前** ----
# 为什么：默认 --test-root = $HOME/dsh-local-test。本机实测 $HOME 在某些 WSL 调用里会被污染成
#   `C:Userszhou1` 这类**非绝对路径** ⇒ 工作根 / DSH_HOME 会落成怪路径（见计划 Task 5 记要）。
# 只在"这个默认值真的会被用到"时校验 —— 即 `--test-root` 与 `DSH_SMOKE_ROOT` 都没给。
# 🔴 `--test-root` / `DSH_SMOKE_ROOT` 的优先级**不变**：给了就完全不依赖 $HOME。
if [[ -z "${DSH_SMOKE_ROOT:-}" && "$TEST_ROOT_FROM_ARG" != "1" && "${HOME:-}" != /* ]]; then
  err "\$HOME 不是绝对路径（= '${HOME:-<未定义>}'）⇒ 默认 --test-root 会落成怪路径（如 C:Userszhou1/dsh-local-test）。"
  err "  修法： ① 用 --test-root <dir> 显式指定工作根；或 ② export HOME=/home/<you> 后重跑。"
  exit 1
fi

REL="$RELEASE_ROOT/$VERSION"
ENTRY_REL="kernel/lib/node_modules/@deepseek-ai/dsh/lib/bin.js"
if [[ -f "$RELEASE_ROOT/current/$ENTRY_REL" ]]; then
  ENTRY="$RELEASE_ROOT/current/$ENTRY_REL"
else
  ENTRY="$REL/$ENTRY_REL"
fi
[[ -f "$ENTRY" ]] || { err "找不到内核入口：$ENTRY（先跑 assemble-release.sh）"; exit 1; }
[[ -f "$SHAPE" ]] || { err "找不到 $SHAPE"; exit 1; }

# 单实例纪律：端口被占就别起
if ss -ltn 2>/dev/null | grep -q ":$PORT"; then
  err "端口 $PORT 已被占用 ⇒ 拒绝起第二实例（本脚本规定单实例）"
  exit 1
fi

mkdir -p "$DSH_HOME/profiles/web/node_modules/@local" "$WORKSPACE"
LOG_FILE="$TEST_ROOT/dsh-$PORT.log"
: > "$LOG_FILE"

log "release   = $REL"
log "入口      = $ENTRY"
log "DSH_HOME  = $DSH_HOME"
log "workspace = $WORKSPACE"
log "端口      = $PORT · 日志 = $LOG_FILE"

# ---- 接线：把 release 的 profile 模板 + 13 个 @local 插件接进**独立** DSH_HOME ----
# 为什么必须做：独立 DSH_HOME 是空的 ⇒ 不接线的话内核挂的是**出厂 profile**，
#   13 个自研插件一条都不在 ⇒ A-5 无从判定（会把"根本没接"当成"没挂上"）。
# ⚠️ 只写 DSH_HOME（在 $HOME 下），**不碰 release**（release 是只读快照）。
wire_plugins() {
  local pdir="$REL/plugins" n=0 p name
  [[ -f "$REL/profile/package.json" ]] && install -m 0644 "$REL/profile/package.json" "$DSH_HOME/profiles/web/package.json"
  # 🔴 第三方 4 个必须**也**接进来（2026-09-26 实测缺口）：
  #    release 的 `profile/node_modules` 里它们是在的（形状自检 T-6 已判），但**独立 DSH_HOME 的
  #    profile 是空的** ⇒ 不接就会报 `INVALID_PATH 无法解析插件路径（既非 file: 也不是可解析的包名）:
  #    dsh-better-sidebar`（实测 4 个第三方**全部 failed**，A-5 因此 FAIL）。
  #    做法与真实部署同构：让 DSH_HOME 的 profile **看见 release 的** node_modules（只读快照不动）。
  local t base sub
  for t in "$REL/profile/node_modules"/*/; do
    [[ -d "$t" ]] || continue
    base="$(basename "${t%/}")"
    if [[ "$base" == @* ]]; then
      mkdir -p "$DSH_HOME/profiles/web/node_modules/$base"
      for sub in "$t"*/; do
        [[ -d "$sub" ]] || continue
        rm -f "$DSH_HOME/profiles/web/node_modules/$base/$(basename "${sub%/}")"
        ln -s "${sub%/}" "$DSH_HOME/profiles/web/node_modules/$base/$(basename "${sub%/}")"
      done
    else
      rm -f "$DSH_HOME/profiles/web/node_modules/$base"
      ln -s "${t%/}" "$DSH_HOME/profiles/web/node_modules/$base"
    fi
  done
  for p in "$pdir"/*/; do
    [[ -d "$p" ]] || continue
    name="$(basename "${p%/}")"
    rm -f "$DSH_HOME/profiles/web/node_modules/@local/$name"
    ln -s "${p%/}" "$DSH_HOME/profiles/web/node_modules/@local/$name"
    n=$((n + 1))
  done
  if [[ -n "$MANIFEST" ]]; then
    [[ -f "$MANIFEST" ]] || { err "--manifest 指定的文件不存在：$MANIFEST"; exit 1; }
    install -m 0644 "$MANIFEST" "$DSH_HOME/hotplug-manifest.yml"
    log "白名单夹具已就位：$MANIFEST → $DSH_HOME/hotplug-manifest.yml（$(count_manifest_ids "$MANIFEST") 条）"
  elif [[ -f "$HOTPLUG_SEED" && ! -f "$DSH_HOME/hotplug-manifest.yml" ]]; then
    install -m 0644 "$HOTPLUG_SEED" "$DSH_HOME/hotplug-manifest.yml"
    log "⚠️ 未给 --manifest ⇒ 用仓库种子（0 条目）⇒ A-5 只能判到「机制就绪」，判不了「13 插件全挂」"
  fi
  log "已接 $n 个 @local 插件 + profile 模板 + 白名单种子 → $DSH_HOME（release 本身未被改动）"
}
if [[ "$WIRE_PLUGINS" == "1" ]]; then wire_plugins; else log "--no-wire-plugins：跳过插件接线（A-5 将记 N/A）"; fi

DSH_HOME="$DSH_HOME" DSH_WORKSPACE_ROOT="$WORKSPACE" \
  node "$ENTRY" web --port "$PORT" >"$LOG_FILE" 2>&1 &
PID=$!
log "已起实例 pid=$PID（就绪超时 ${READY_TIMEOUT}s）"

FAILS=()
pass() { printf '  %-5s PASS  %s\n' "$1" "$2"; }
fail() { printf '  %-5s FAIL  %s\n' "$1" "$2"; FAILS+=("$1"); }
skip() { printf '  %-5s SKIP  %s\n' "$1" "$2"; }
note() { printf '  %-5s NOTE  %s\n' "$1" "$2"; }

peak_mem() { [[ -r "/proc/$PID/status" ]] && awk '/VmHWM/{print $2" "$3}' "/proc/$PID/status" 2>/dev/null || true; }

cleanup_instance() {
  if [[ "$KEEP" == "1" ]]; then
    log "--keep：实例保持运行（pid=$PID）。记得手工结束。"
    return
  fi
  kill "$PID" 2>/dev/null || true
  for _ in $(seq 1 20); do kill -0 "$PID" 2>/dev/null || break; sleep 0.5; done
  kill -9 "$PID" 2>/dev/null || true
  log "实例已停（pid=$PID）"
}
trap cleanup_instance EXIT

# ---------------------------------------------------------------- A-1 就绪
# ⚠️ curl 失败时 `-w '%{http_code}'` 会打印 000，**且** `|| echo 000` 还会再打一次
#    ⇒ 直接拼接会得到 "000000" 这种假值。必须先**规范化**再比较。
http_code() {  # $1 = 路径
  local c
  c="$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "${CURL_AUTH[@]+${CURL_AUTH[@]}}" "http://127.0.0.1:$PORT${1:-/}" 2>/dev/null)" || c=000
  [[ "$c" =~ ^[0-9]{3}$ ]] || c=000
  printf '%s' "$c"
}
CURL_AUTH=()   # 就绪阶段还没有 cookie
t0=$(date +%s)
code=000
while :; do
  c="$(http_code /)"
  [[ "$c" == "200" || "$c" == "401" ]] && { code="$c"; break; }
  kill -0 "$PID" 2>/dev/null || { code="$c"; break; }
  elapsed=$(( $(date +%s) - t0 ))
  (( elapsed >= READY_TIMEOUT )) && { code="$c"; break; }
  sleep 1
done
elapsed=$(( $(date +%s) - t0 ))
if [[ "$code" == "200" || "$code" == "401" ]] && (( elapsed < READY_TIMEOUT )); then
  pass A-1 "就绪 ${elapsed}s（/ 返回 $code；阈值 < ${READY_TIMEOUT}s）"
else
  fail A-1 "未在 ${READY_TIMEOUT}s 内就绪（/ 返回 $code；进程存活=$([[ -d /proc/$PID ]] && echo yes || echo no)）⇒ 看 $LOG_FILE"
fi

# ---------------------------------------------------------------- token + cookie
TOKEN=""
for _ in $(seq 1 10); do
  TOKEN="$(grep -o 'token=[A-Za-z0-9_-]*' "$LOG_FILE" 2>/dev/null | head -1 | cut -d= -f2 || true)"
  [[ -n "$TOKEN" ]] && break
  sleep 1
done
JAR="$(mktemp)"
if [[ -n "$TOKEN" ]]; then
  curl -s -o /dev/null -c "$JAR" "http://127.0.0.1:$PORT/?token=$TOKEN" 2>/dev/null || true
  CURL_AUTH=(-b "$JAR")
  note TOKEN "从日志取到 token（长度 ${#TOKEN}），已换 cookie"
else
  CURL_AUTH=()
  note TOKEN "日志里没有 token=…（HTTP 401 时后续需要它）"
fi

# ---------------------------------------------------------------- A-2 / A-3 日志
h2="$(grep -cE 'Reached heap limit|FATAL ERROR' "$LOG_FILE" 2>/dev/null || true)"
if [[ "${h2:-0}" -eq 0 ]]; then pass A-2 "无 'Reached heap limit' / 'FATAL ERROR'"; else fail A-2 "$h2 行堆上限/致命错误（$LOG_FILE）"; fi

p3="$(grep -E 'patch: (entry|insert|name)' "$LOG_FILE" 2>/dev/null || true)"
if [[ -z "$p3" ]]; then pass A-3 "无 patch: 告警（补丁层匹配上了）"; else fail A-3 "有 patch: 告警（补丁行静默跳过 ⇒ fail-open）：$(printf '%s' "$p3" | head -3)"; fi

# ---------------------------------------------------------------- A-6 首页（带 cookie）
code6="$(http_code /)"
if [[ "$code6" == "200" ]]; then
  pass A-6 "带 cookie 的 curl / == 200"
elif [[ -z "$TOKEN" ]]; then
  fail A-6 "无 token ⇒ 无法判 A-6（裸 / 返回 $code6，401 属正常鉴权）"
else
  fail A-6 "带 cookie 的 curl / == $code6（期望 200）"
fi

# ---------------------------------------------------------------- A-4 树扁平（复用 T-4）
shape_out="$(bash "$SHAPE" --version "$VERSION" --release-root "$RELEASE_ROOT" --accept-diff T-7 --accept-diff T-2 --accept-diff T-3 2>&1 || true)"
t4="$(printf '%s\n' "$shape_out" | grep -E '^  T-4' || true)"
if printf '%s' "$t4" | grep -q PASS; then pass A-4 "树扁平（check-tree-shape.sh T-4 PASS）"; else fail A-4 "T-4 未过：$t4"; fi

# ---------------------------------------------------------------- A-5 插件全挂
if [[ "$WIRE_PLUGINS" != "1" ]]; then
  skip A-5 "未接线（--no-wire-plugins）⇒ A-5 记 N/A（**不是通过**）"
else
  # 🔴 证据口径（2026-09-26 本机实测修正）：
  #   内核 **stdout 里没有插件挂载行**（实测只有 2 行：token 行 + "opening the default browser"）。
  #   真正的证据在两个文件：
  #     ① $DSH_HOME/dsh-adapter-apply.log：`APPLY_DONE … localPlugins=13(硬不匹配0/探针兜底0) status=…`
  #        + `ROUTE_REGISTERED /adapter/api`  ⇒ 证明 **adapter 本体挂上了、hotplug 机制就绪**
  #     ② $DSH_HOME/logs/hotplug-audit.jsonl：`hotplug.autoload.done loaded=N failed=M`
  #        ⇒ N 由**白名单条目数**决定；⚠️ 仓库里的 `hotplug-manifest.seed.yml` 是 **0 条目**，
  #          而白名单**不进包、不切**（整包式设计 §②-7(b)#3）⇒ 全新 DSH_HOME 上必然 loaded=0。
  #          ⇒ 想判"13 插件全挂"必须**额外提供一份白名单夹具**（见 --manifest）。见计划 §自查-4 G7。
  ADAPTER_LOG="$DSH_HOME/dsh-adapter-apply.log"
  AUDIT="$DSH_HOME/logs/hotplug-audit.jsonl"
  a_ok=0
  if [[ -f "$ADAPTER_LOG" ]] && grep -q 'APPLY_DONE' "$ADAPTER_LOG" 2>/dev/null; then a_ok=1; fi
  r_ok=0
  if [[ -f "$ADAPTER_LOG" ]] && grep -q 'ROUTE_REGISTERED /adapter/api' "$ADAPTER_LOG" 2>/dev/null; then r_ok=1; fi
  auto_line=""
  [[ -f "$AUDIT" ]] && auto_line="$(grep -o 'hotplug.autoload.done[^}]*' "$AUDIT" 2>/dev/null | tail -1 || true)"
  loaded_n="0"
  if [[ -n "$auto_line" ]]; then
    loaded_n="$(printf '%s' "$auto_line" | sed -n 's/.*loaded=\([0-9]\+\).*/\1/p')"
    [[ -n "$loaded_n" ]] || loaded_n=0
  fi
  # ⚠️ `grep -c` 在 0 命中时会**同时**打印 "0" 并返回非 0 ⇒ 不能写 `$(grep -c ... || echo 0)`
  #    （那会得到 "0\n0" 这种值，`(( ))` 直接语法错，实测踩到）。必须先取值再单独兜底。
  manifest_n=0
  if [[ -f "$DSH_HOME/hotplug-manifest.yml" ]]; then
    manifest_n="$(grep -c '^[[:space:]]*- id:' "$DSH_HOME/hotplug-manifest.yml" 2>/dev/null)" || manifest_n=0
  fi
  [[ "$manifest_n" =~ ^[0-9]+$ ]] || manifest_n=0
  [[ "$loaded_n" =~ ^[0-9]+$ ]] || loaded_n=0

  if (( a_ok == 1 && r_ok == 1 )) && printf '%s' "$auto_line" | grep -q 'failed=0'; then
    if (( manifest_n == 0 )); then
      pass A-5 "adapter 就绪（APPLY_DONE + /adapter/api 已注册）且 autoload failed=0；⚠️ 白名单 0 条目 ⇒ loaded=0 ⇒ **本条只证明「机制就绪」，未证明「13 插件全挂」**"
    elif (( loaded_n >= manifest_n )); then
      pass A-5 "adapter 就绪且白名单 $manifest_n 条全挂（loaded=$loaded_n failed=0）"
    else
      fail A-5 "白名单 $manifest_n 条但 loaded=$loaded_n（未全挂）⇒ 看 $AUDIT"
    fi
  else
    fail A-5 "adapter 未就绪（APPLY_DONE=$a_ok ROUTE_REGISTERED=$r_ok autoload='${auto_line:-<无>}'）⇒ 看 $ADAPTER_LOG"
  fi
fi

# ---------------------------------------------------------------- B-1 历史会话（信封式 RPC）
rpc_dir="$(mktemp -d)"
B1=0
if [[ -n "$TOKEN" ]]; then
  list_body='{"type":"client-request","rpcId":"smoke-list","method":"session/list","payload":{"args":{"_request":{}}}}'
  list_out="$(curl -s "${CURL_AUTH[@]}" -H 'content-type: application/json' \
      --data "$list_body" "http://127.0.0.1:$PORT/api/session/list" 2>/dev/null || true)"
  echo "$list_out" > "$rpc_dir/list.json"
  # ⚠️ 实测返回结构：result.value.**items[]**（不是 sessions）；每条带 projections.asOfSeq
  sid="$(node -e '
    let j = {}; try { j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")) } catch (e) {}
    const v = (((j||{}).result||{}).value)||{}
    const arr = v.items || v.sessions || []
    if (!Array.isArray(arr) || arr.length === 0) process.exit(0)
    const s = arr[0]
    const asOf = Number((((s||{}).projections||{}).asOfSeq) ?? 0)
    process.stdout.write(String(s.sessionId || s.id || "") + " " + String(asOf))
  ' "$rpc_dir/list.json" 2>/dev/null || true)"
  set -- $sid
  SESS_ID="${1:-}"; ASOF="${2:-0}"
  if [[ -n "$SESS_ID" ]]; then
    page_body="$(node -e '
      process.stdout.write(JSON.stringify({
        type: "client-request", rpcId: "smoke-page", method: "session/page",
        payload: { args: { request: { address: { kind: "session", sessionId: process.argv[1] },
                                    throughSeq: Number(process.argv[2]), maxMessages: 20 } } }
      }))
    ' "$SESS_ID" "$ASOF")"
    page_out="$(curl -s "${CURL_AUTH[@]}" -H 'content-type: application/json' \
        --data "$page_body" "http://127.0.0.1:$PORT/api/session/page" 2>/dev/null || true)"
    echo "$page_out" > "$rpc_dir/page.json"
    if printf '%s' "$page_out" | grep -q '"records"'; then
      B1=1
      pass B-1 "session/list 取到会话 ${SESS_ID:0:8}…；session/page（throughSeq=$ASOF）返回 records ✓"
    else
      fail B-1 "session/page 未返回 records：$(printf '%s' "$page_out" | head -c 200)"
    fi
  elif printf '%s' "$list_out" | grep -q '"items"'; then
    B1=1
    pass B-1 "session/list 通（独立 DSH_HOME 尚无历史会话 ⇒ items 为空，属预期）"
  else
    fail B-1 "session/list 未返回 items：$(printf '%s' "$list_out" | head -c 200)"
  fi
else
  fail B-1 "无 token ⇒ 无法调会话 RPC（日志里找不到 token=…）"
fi

# ---------------------------------------------------------------- B-3 工作区读写
probe="$WORKSPACE/.smoke-probe.txt"
if printf 'smoke %s\n' "$(date -u +%FT%TZ)" > "$probe" 2>/dev/null && grep -q smoke "$probe" 2>/dev/null; then
  pass B-3 "独立 workspace 读写探针成功（$probe）"
  rm -f "$probe"
else
  fail B-3 "workspace 不可写：$WORKSPACE"
fi

# ---------------------------------------------------------------- B-2 新会话跑通一轮
if [[ "$RUN_TURN" != "1" ]]; then
  skip B-2 "未跑真实对话轮次（未给 --run-turn）—— **本结论不含 B-2**"
elif [[ ! -f "$DSH_HOME/.credentials.yaml" || ! -s "$DSH_HOME/.credentials.yaml" ]]; then
  skip B-2 "未跑真实对话轮次（$DSH_HOME/.credentials.yaml 不存在或为空：WSL2 上未放模型 API key）"
else
  # session/create 的 args 形如 { request: {...} }（实测：传 _request 会被内核拒绝，
  # 报 'missing "request"; unexpected "_request"'）—— 与 session/list 的写法**不同**。
  create_body='{"type":"client-request","rpcId":"smoke-create","method":"session/create","payload":{"args":{"request":{"cwd":"'"$WORKSPACE"'","title":"local-smoke"}}}}'
  create_out="$(curl -s "${CURL_AUTH[@]}" -H 'content-type: application/json' --data "$create_body" \
      "http://127.0.0.1:$PORT/api/session/create" 2>/dev/null || true)"
  echo "$create_out" > "$rpc_dir/create.json"
  NSID="$(node -e '
    let j={}; try{ j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")) }catch(e){}
    const v=((j||{}).result||{}).value||{}
    process.stdout.write(String(v.sessionId||v.id||""))
  ' "$rpc_dir/create.json" 2>/dev/null || true)"
  if [[ -n "$NSID" ]]; then
    prompt_body="$(node -e '
      process.stdout.write(JSON.stringify({
        type:"client-request", rpcId:"smoke-prompt", method:"session/prompt",
        payload:{ args:{ request:{ address:{kind:"session", sessionId:process.argv[1]},
                                   content:[{type:"text", text:"ping（本地冒烟，请只回 pong）"}] } } }
      }))' "$NSID")"
    prompt_out="$(curl -s "${CURL_AUTH[@]}" -H 'content-type: application/json' --data "$prompt_body" \
        "http://127.0.0.1:$PORT/api/session/prompt" 2>/dev/null || true)"
    echo "$prompt_out" > "$rpc_dir/prompt.json"
    if printf '%s' "$prompt_out" | grep -qiE '"error"'; then
      fail B-2 "session/prompt 报错：$(printf '%s' "$prompt_out" | head -c 200)"
    else
      pass B-2 "新会话 $NSID 跑通一轮（回包见 $rpc_dir/prompt.json）"
    fi
  else
    fail B-2 "session/create 未返回 sessionId：$(printf '%s' "$create_out" | head -c 200)"
  fi
fi

# ---------------------------------------------------------------- 汇总
PEAK="$(peak_mem)"
echo
log "峰值内存（VmHWM）= ${PEAK:-<未采到>}"
if [[ ${#FAILS[@]} -gt 0 ]]; then
  err "❌ A/B 栏有 FAIL：${FAILS[*]}"
  rm -rf "$rpc_dir" "$JAR"
  exit 2
fi
log "✅ 冒烟通过（A 栏全过；B 栏按上面口径执行）"
log "   ⚠️ 与服务器的差异（R1）：内存 / 网关 / 白名单 / 客户端壳 四项**必须写进结论**，不得省略。"
rm -rf "$rpc_dir" "$JAR"
exit 0
