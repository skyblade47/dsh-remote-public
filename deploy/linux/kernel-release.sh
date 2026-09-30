#!/usr/bin/env bash
# =============================================================================
# kernel-release.sh —— 版本化 release 目录：安装 / 状态 / 基线 / 切换 / 校验 / 回滚
# =============================================================================
#
# 定位（P6a 阶段 A，按"整包式"设计的修订口径）：
#   现在这台机器上只有一个**原地被覆盖的全局 npm 包**，所以"回滚"没有回滚目标。
#   本脚本把内核改成 **版本化目录 + 原子切换**：旧版本原地存档、`current` 一个软链翻转。
#
# 一个 release 的内容（整包式设计 §②-7）：
#   ① 内核 `@deepseek-ai/dsh/**` + 依赖树（npm prefix 形态）
#   ② 12 个自研插件**快照**
#   ③ profile 两键（`dsh.profile.bundles` + `dependencies`）+ `pnpm-lock.yaml`
#   ⚠️ 4 个第三方插件（pnpm store 形态）与 `profiles/web/node_modules` 的归属
#      尚有 P-A/P-B/P-C 三个方案**未拍板**（§②-9(b) / §⑤#15）⇒ 本脚本**不碰它们**，
#      只做"内核对齐"；切换/回滚处都留了 TODO 锚点。
#
# 目录布局（推荐方案 R1，待拍板 §⑤#13）：
#   /usr/local/dsh-release/
#     <ver>/
#       kernel/     ← npm prefix：bin/dsh + lib/node_modules/@deepseek-ai/dsh/**
#       plugins/    ← 12 个自研插件快照（纯目录）
#       profile/    ← package.json（该 release 配套的两键）+ pnpm-lock.yaml
#       release.json
#     current -> <ver>     ★ **唯一被翻转的东西**（ln -s + mv -Tf，同 fs rename(2)，原子）
#     runtime -> current/kernel/lib/node_modules/@deepseek-ai/dsh/node_modules
#                          ← 稳定路径，喂 /etc/dsh-remote.env 的 DSH_RUNTIME_ROOT
#     state.json           ← 机器级状态（current / phase / from / baseline / …）
#   ⚠️ 本版按 R1 **写死**（见下面 RELEASE_ROOT / RUNTIME_REL）。若拍板改回
#      `/usr/local/dsh-kernel/<ver>/`（R2），只需改这两个常量 —— 但 `runtime` 的相对目标
#      必须同步改成 `current/kernel/lib/...`，否则 DSH_RUNTIME_ROOT 会指向不存在的路径。
#
# 🔴 三条铁律（违反其一即服务/数据级事故）：
#   1. 本脚本是 `restart-kernel.sh` 之外的**第二处重启入口**（P6a R9 / ⑦-8）。
#      门闸口径必须与它**逐字一致**：只有 HTTP 200 才算"拿到判定"；取不到 ⇒ **fail-closed**。
#   2. **回滚必须走 `restart-kernel.sh --force`**：新包起不来时，门闸端点（住在内核进程里的
#      `@local/dsh-adapter`）也不可用 ⇒ 正常路径会 `exit 3` **拒绝重启**（P6a ⑦-1）。
#   3. 切换/回滚**只翻符号链接 + 重启**：绝不动 `DSH_HOME` 数据、绝不迁移数据、绝不删版本目录。
#
# ⚠️ 实施前必须先 rsync（P6a R8 / 交接文档 §⑧-10）：
#   服务器 `/opt/dsh-remote/deploy/linux/*` 是 **Sep-23 的旧版**。在旧脚本上改 = 白改。
#
# ⚠️ 别拿 WARN 当判据（P6a ⑦-2 / 交接文档 §⑧-8）：`check-ready.sh` 的 WARN 数**不是常量**。
#   本脚本只用它的 **FAIL 基线差分**，且差分前把数字归一化（端口/字节数会变）。
#
# 退出码：0=成功 / 1=用法或环境错误 / 2=判定不放行（有在飞 / 数据已被新版写过）
#         3=取不到判定（fail-closed）
#
# 🟢 状态（2026-09-27 更正）：**已投产**。本脚本**已在服务器上执行过真升级**（`0.1.5-rc.1 → 0.1.5-rc.3`，
#    `state.json` 记 `rollbackCount = 1`）：release 目录已建、`current` 软链已翻过，`@local/*` 自研插件
#    现在解析到 `/usr/local/dsh-release/<current>/plugins/**`。
#    🔴 上一版这里写的是"**草案** / **未在任何服务器上执行过** / 未建任何服务器目录" —— **已全部过期**。
#    这句错误声明曾让人误判"仓库这份不可用、应以服务器上那份为准"（实测**恰好相反**：服务器 `/opt` 镜像那份才是旧的，
#    它停在"固化 rc.3 钉点"那次提交的**父提交**内容）。⇒ 别再用文件头自述判断投产状态，用
#    `tools/mirror-audit.mjs`（仓库↔镜像一致性对账）与 `release.json` / `state.json`（真实版本与回滚记录）。
#    §⑤ 的 19 点拍板仍有**未定项**（第三方插件与 profiles 归属，见 §②-9），但它们**不阻塞**已投产的部分。

set -uo pipefail

# ----------------------------------------------------------------- 常量

RELEASE_ROOT="${DSH_RELEASE_ROOT:-/usr/local/dsh-release}"
RUNTIME_REL="kernel/lib/node_modules/@deepseek-ai/dsh/node_modules"   # 见头部 R1/R2 说明
DSH_HOME="${DSH_HOME:-/srv/dsh-home}"
SERVICE_USER="${DSH_SERVICE_USER:-dsh}"
KERNEL_UNIT="${DSH_KERNEL_UNIT:-dsh-kernel}"
KERNEL_PORT="${DSH_KERNEL_PORT:-3080}"
NPM_MIRROR="${DSH_NPM_MIRROR:-https://registry.npmmirror.com}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CHECK_READY="$REPO_ROOT/deploy/linux/check-ready.sh"
RESTART_KERNEL="$REPO_ROOT/deploy/linux/restart-kernel.sh"
TEMPLATE_DIR="$REPO_ROOT/server/data/templates"
PLUGIN_SRC="$REPO_ROOT/plugins"

STATE="$RELEASE_ROOT/state.json"
CURRENT_LINK="$RELEASE_ROOT/current"
RUNTIME_LINK="$RELEASE_ROOT/runtime"

PROFILE_TEMPLATE="profile-web-minimal.package.json"   # = 现役 profile 形态（3 bundles + 4 第三方）
NPM_BEFORE=""
GIT_COMMIT=""
NPM_OFFLINE=0   # 1 = npm 也走 --offline（本地装配器的 --offline 会打开它）

FORCE=0
DRY_RUN=0
ACCEPT_DATA_RISK=0

usage() {
  cat <<'EOF'
用法: kernel-release.sh <子命令> [选项]

  install <ver> [--npm-before <ISO>] [--profile-template <name|绝对路径>] [--git-commit <sha>] [--npm-offline]
      把 <ver> 装成 /usr/local/dsh-release/<ver>/（内核 npm prefix + 自研插件快照 +
      profile 两键/lockfile + release.json）。**绝不翻转 current**（首次迁移要求人工确认）。
      --npm-before 传上游发版钉点；不传则告警（不钉 ⇒ 依赖树可能漂移成嵌套 ⇒ 内核 crash-loop）。
      --npm-offline 给 npm 加 `--offline`：**任何需要联网才能拿到的包 ⇒ 非 0 退出**（fail-closed）。

  status
      只读：打印 current / runtime / 各版本 release.json 摘要 / state.json /
      @local/* 12 条链接的解析目标（**只报不修**）。

  baseline [--record]
      跑 check-ready.sh 取 FAIL 行集合（数字已归一化）写进 state.json.baseline。
      不带 --record 时只打印、不落盘。

  switch <ver> [--force] [--skip-gate]
      门闸判定 → 记基线 → **原子翻转 current** → 重启内核 → 置 phase=verifying。
      之后用 `verify` 判定。翻转与重启**不是**一个原子操作 ⇒ 用 state.json 的 phase 兜。

  verify [--window <sec>] [--no-pa]
      跑六条判据：H1 NRestarts 增长 / H2 撞堆上限·FATAL / H3 3080 不通 /
      R check-ready **FAIL 基线差分**（**不看 WARN**：它不是常量）/
      **H4(A9) journal 无 fallback·权限类错误** /
      **H5(A10) profiles/web/node_modules 仍是软链、且指向目标 release**。
      ⇒ H4/H5 是 **P-A 方案 (a)（release 只读）的硬验收**：只读 ⇒ heal 想写就 EACCES ⇒ boot 崩，
        故"起得来"已是"零写入"的必要条件，H4/H5 补充分面。走 P-B/P-C 时用 --no-pa 跳过。

  rollback [--to <ver>] [--accept-data-risk]
      手工回滚：先判"数据是否已被新版写过"（P6a ②-2(B)）→ 翻转 current →
      **`restart-kernel.sh --force`**（新包起不来时门闸也没了，必须 --force）。
      有文件被新版写过而未给 --accept-data-risk ⇒ 拒绝（exit 2）。

  selftest
      A9（H4）判据的正反例自测（合成日志）—— **不碰 journal / 服务器，不需要 root**。
      为什么要有它：A9 是硬门闸，且它曾经是一条"永远返回 ✓"的判据（口径缺陷已修）。

  通用选项: --dry-run（只打印，不落盘/不重启）  -h|--help

退出码: 0=成功  1=用法/环境错误  2=判定不放行  3=取不到判定（fail-closed）

⚠️ 待拍板（本脚本按**推荐值**写死，拍板后需回来改）：
   §⑤#13 目录改名 R1/R2 · §⑤#14 @local/* 指向 current 的一次性迁移 ·
   §⑤#15 第三方 P-A/P-B/P-C · §⑤#16 前端/网关不进包 · §⑤#19 /opt/.../plugins 降级为 staging
EOF
}

log()  { printf '[kernel-release] %s\n' "$*"; }
warn() { printf '[kernel-release] ⚠️  %s\n' "$*" >&2; }
err()  { printf '[kernel-release] 错误: %s\n' "$*" >&2; }
die()  { err "$*"; exit 1; }
refuse() { err "$*"; exit 2; }
no_judgement() { err "$*"; exit 3; }

require_root() { [[ "${EUID:-$(id -u)}" -eq 0 ]] || die "请用 root 运行（sudo $0 ...）：要写 /usr/local 与重启 systemd 单元。"; }
need_cmd() { command -v "$1" >/dev/null 2>&1 || die "缺少命令：$1"; }

run() {  # 统一 --dry-run 出口
  if [[ "$DRY_RUN" == "1" ]]; then log "[dry-run] $*"; return 0; fi
  "$@"
}

# H4/A9 判据的**纯函数形式**：stdin = 日志文本，$1 = release 根；输出 = 命中行数。
# 抽成函数是为了**可自测**（selftest 用合成日志喂它）—— 一条永远不会 ✓→✗ 的门闸等于没有门闸。
#
# 🔴 口径（2026-09-26 修正，对应整包式设计 §A.3 #8 的实测发现）：
#   **两个路径域任一命中即计入**：
#     ① 提及 $1（release 被触碰）；
#     ② 提及 profiles 下的 node_modules（= heal 的写入面）。
#   为什么必须加 ②：夹具 B-3/B-4 实测，heal 试图写"缺条目 / 多条目"时，报错文本写的是
#     **DSH_HOME 侧路径**，形如
#       EACCES: permission denied, symlink '…' -> '<DSH_HOME>/profiles/web/node_modules/<x>'
#     **不含** release 字面 ⇒ 旧口径（只 grep release）**永远判 ✓**，等于不判。
#   为什么不会因此误判（原"收紧"的理由仍然成立）：**成功写入不留 EACCES 行** ——
#     切包瞬间 heal 重建 DSH_HOME 侧 `profiles/node_modules` 的 ~163 条软链是**正常且成功**的，
#     不会出现在本计数里；本计数只收"权限类错误"行。
a9_hits() {
  local rel="$1"
  grep -E 'EACCES|EPERM|exists and is not a symlink' \
    | grep -cE -e "$rel" -e 'profiles/[^ ]*node_modules' || true
}

# ----------------------------------------------------------------- state.json / 审计

# 读 state.json 的一个点路径字段（不存在 ⇒ 输出空、退出码 0）
state_field() {
  [[ -f "$STATE" ]] || return 0
  node -e '
    const fs = require("fs")
    let s = {}
    try { s = JSON.parse(fs.readFileSync(process.argv[1], "utf8")) } catch (e) { process.exit(0) }
    let v = s
    for (const k of process.argv[2].split(".")) { v = (v == null ? undefined : v[k]) }
    if (v === undefined || v === null) process.exit(0)
    process.stdout.write(typeof v === "object" ? JSON.stringify(v) : String(v))
  ' "$STATE" "$1"
}

# 合并写 state.json（临时文件 + rename ⇒ 读者永远看到完整 JSON）
state_patch() {
  if [[ "$DRY_RUN" == "1" ]]; then log "[dry-run] state.json <- $1"; return 0; fi
  node -e '
    const fs = require("fs")
    const f = process.argv[1]
    let s = {}
    try { s = JSON.parse(fs.readFileSync(f, "utf8")) } catch (e) {}
    Object.assign(s, JSON.parse(process.argv[2]))
    const tmp = f + ".tmp"
    fs.writeFileSync(tmp, JSON.stringify(s, null, 2) + "\n", { mode: 0o644 })
    fs.renameSync(tmp, f)
  ' "$STATE" "$1" || die "写 state.json 失败：$STATE"
}

# 审计：$DSH_HOME/logs/update-audit.jsonl（沿用 server-update-mechanism-design §10 的文件名）
audit() {
  local ev="$1" extra="${2:-{\}}"
  if [[ "$DRY_RUN" == "1" ]]; then log "[dry-run] audit $ev $extra"; return 0; fi
  install -d -m 0755 "$DSH_HOME/logs" 2>/dev/null || true
  node -e '
    const fs = require("fs")
    const rec = Object.assign(
      { at: new Date().toISOString(), event: process.argv[1], by: "kernel-release.sh" },
      JSON.parse(process.argv[2] || "{}"))
    fs.appendFileSync(process.argv[3], JSON.stringify(rec) + "\n")
  ' "$ev" "$extra" "$DSH_HOME/logs/update-audit.jsonl" 2>/dev/null \
    || warn "写审计失败（不阻断）：$DSH_HOME/logs/update-audit.jsonl"
}

# 数组 → JSON（stdin 按行读，去空行）
lines_to_json_array() {
  node -e '
    let r = ""
    process.stdin.on("data", (c) => { r += c })
    process.stdin.on("end", () => {
      process.stdout.write(JSON.stringify(r.split("\n").map((s) => s.trim()).filter(Boolean)))
    })
  '
}

# ----------------------------------------------------------------- 只读探针

rel_json() {  # $1=ver  $2=点路径
  local f="$RELEASE_ROOT/$1/release.json"
  [[ -f "$f" ]] || return 0
  node -e '
    const fs = require("fs")
    let s = {}
    try { s = JSON.parse(fs.readFileSync(process.argv[1], "utf8")) } catch (e) { process.exit(0) }
    let v = s
    for (const k of process.argv[2].split(".")) { v = (v == null ? undefined : v[k]) }
    if (v === undefined || v === null) process.exit(0)
    process.stdout.write(typeof v === "object" ? JSON.stringify(v) : String(v))
  ' "$f" "$2"
}

release_versions() {
  local d
  for d in "$RELEASE_ROOT"/*/; do
    [[ -d "$d" ]] || continue
    basename "${d%/}"
  done
}

kernel_version_of() {  # $1 = ver → 该 release 里内核 package.json 的 version
  local p="$RELEASE_ROOT/$1/kernel/lib/node_modules/@deepseek-ai/dsh/package.json"
  [[ -f "$p" ]] || return 1
  node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).version)' "$p"
}

nrestarts() { systemctl show "$KERNEL_UNIT" -p NRestarts --value 2>/dev/null || echo ""; }

# check-ready 的 FAIL 行集合（**数字归一化** —— 端口/字节数/耗时每次都变，不归一化会次次"新 FAIL"）
check_ready_fail_set() {
  local out
  out="$(bash "$CHECK_READY" 2>&1 || true)"
  printf '%s\n' "$out" | grep -F '❌ FAIL' | sed -E 's/^[[:space:]]+//; s/[0-9]+/N/g' | sort -u
}

# 门闸快照（best-effort；**不参与放行判定**，只用于事后说明"这次重启掐断了什么"）
gate_snapshot() {
  local body
  body="$(curl -sS --max-time 10 "http://127.0.0.1:${KERNEL_PORT}/adapter/api/resume/gate" 2>/dev/null)" || { echo '{}'; return 0; }
  printf '%s' "$body" | node -e '
    let raw = ""
    process.stdin.on("data", (c) => { raw += c })
    process.stdin.on("end", () => {
      try {
        const j = JSON.parse(raw)
        process.stdout.write(JSON.stringify({
          ok: j.ok, safe: j.safe,
          openTurns: (j.counts || {}).openTurns,
          delegations: (j.counts || {}).delegations,
          liveSessions: (j.counts || {}).liveSessions,
          checkedAt: j.checkedAt,
        }))
      } catch (e) { process.stdout.write("{}") }
    })
  ' 2>/dev/null || echo '{}'
}

# 建/校正**稳定软链** runtime -> current/<RUNTIME_REL>。
# 🔴 为什么必须有它：/etc/dsh-remote.env 的 DSH_RUNTIME_ROOT 就指向它；没有它，
#    "版本相关绝对路径收敛成 2 个软链"这个设计**缺一半**，且 setup.sh 的 profile 装配会拿到不存在的路径。
# 它是**相对**链接（相对 release 根）⇒ current 翻转后自动跟随，切换时不需要重建。
ensure_runtime_link() {
  local want="current/$RUNTIME_REL" got
  if [[ -L "$RUNTIME_LINK" ]]; then
    got="$(readlink "$RUNTIME_LINK" 2>/dev/null || true)"
    if [[ "$got" == "$want" ]]; then
      log "runtime 软链已就位：runtime -> $want ✓"
      return 0
    fi
    warn "runtime 软链指向 '$got' ≠ 期望 '$want' ⇒ 校正（它是稳定链接，目标串不应被改）"
    run rm -f "$RUNTIME_LINK"
  fi
  run ln -s "$want" "$RUNTIME_LINK"
  log "已建 runtime 软链：runtime -> $want（⛔ 若 current 尚不存在，它暂时是**断链**，属预期）"
}

# ----------------------------------------------------------------- install

cmd_install() {
  local ver="${1:-}"; [[ -n "$ver" ]] && shift || true
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --npm-before)       NPM_BEFORE="${2:-}"; shift 2 ;;
      --profile-template) PROFILE_TEMPLATE="${2:-}"; shift 2 ;;
      --git-commit)       GIT_COMMIT="${2:-}"; shift 2 ;;
      --npm-offline)      NPM_OFFLINE=1; shift ;;
      *) die "install 未知参数：$1" ;;
    esac
  done
  [[ -n "$ver" ]] || die "install 需要 <ver>（如 0.1.5-rc.1）"
  [[ "$ver" != */* ]] || die "<ver> 不能含 /（收到 '$ver'）"

  # ---- $HOME 校验（S3 / B4）：fail-fast，放在**参数解析之后、动作之前** ----
  # 为什么：install 会调用 npm / rsync / git，并读 `$DSH_HOME/profiles/web/…`；npm/git 都按
  #   $HOME 定位缓存 / 配置，本机实测 $HOME 在某些 WSL 调用里会被污染成 `C:Userszhou1` 这类
  #   **非绝对路径** ⇒ 缓存/配置落点不可信（装配产物因此不可信）。
  #   `set -uo pipefail` 下 $HOME 可能未定义 ⇒ 用 `${HOME:-}` 兜底再比较。
  #   放在这里（而不是 main 入口）：status/verify/baseline/selftest 不需要 $HOME，别把它们也拦了。
  if [[ "${HOME:-}" != /* ]]; then
    die "\$HOME 不是绝对路径（= '${HOME:-<未定义>}'）⇒ npm/git 会按它定位缓存/配置，install 结果不可信。
     修法： export HOME=/home/<you> 后重跑；若要固定数据目录，另行显式 export DSH_HOME=<绝对路径>。"
  fi
  require_root
  need_cmd npm; need_cmd node; need_cmd rsync; need_cmd sha256sum; need_cmd find

  local target="$RELEASE_ROOT/$ver"
  # --profile-template 既可以是**模板名**（相对 $TEMPLATE_DIR），也可以是**绝对路径**
  # （后者用于"忠实记录线上实际在跑的那份 package.json"，见 P6a A.4 的首次迁移）。
  local tpl
  if [[ "$PROFILE_TEMPLATE" == */* ]]; then tpl="$PROFILE_TEMPLATE"; else tpl="$TEMPLATE_DIR/$PROFILE_TEMPLATE"; fi
  [[ -f "$tpl" ]] || die "profile 模板不存在：$tpl（可给模板名，也可给绝对路径）"
  [[ -d "$PLUGIN_SRC" ]] || die "插件源目录不存在：$PLUGIN_SRC"

  if [[ -z "$NPM_BEFORE" ]]; then
    warn "未钉传递依赖（--npm-before 为空）：上游一发版就可能装出"嵌套"依赖树 ⇒ 内核启动即 crash-loop"
    warn "  现役口径见 setup.sh 头的 NPM_BEFORE_DEFAULT（**按内核版本登记**）："
    warn "    rc.1 → 2026-09-10T12:00:00Z；rc.3 → 2026-09-22T16:00:00Z"
  fi
  if [[ -z "$GIT_COMMIT" ]]; then
    GIT_COMMIT="$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || true)"
  fi

  log "目标 release：$target"
  log "内核：@deepseek-ai/dsh@$ver（prefix=$target/kernel，registry=$NPM_MIRROR）"
  run install -d -m 0755 "$target" "$target/kernel" "$target/plugins" "$target/profile"

  # ---- 1) 内核：npm 装到**本 release 的 prefix**（不碰 /usr/local/bin、不碰现役全局包）----
  if [[ -f "$target/kernel/lib/node_modules/@deepseek-ai/dsh/package.json" ]] \
     && [[ "$(kernel_version_of "$ver" 2>/dev/null || true)" == "$ver" ]]; then
    log "内核已就位于该 prefix（幂等，跳过 npm）"
  else
    local beforeFlag=() offlineFlag=()
    [[ -n "$NPM_BEFORE" ]] && beforeFlag=(--before="$NPM_BEFORE")
    [[ "$NPM_OFFLINE" == "1" ]] && offlineFlag=(--offline)
    # shellcheck disable=SC2086  # NODE_OPTIONS 需沿用既有值再追加（与 setup.sh npm_install_g 同口径）
    run env NODE_OPTIONS="${NODE_OPTIONS:-} --dns-result-order=ipv4first" \
      npm install -g --prefix "$target/kernel" \
        --registry="$NPM_MIRROR" --fetch-timeout=900000 --fetch-retries=5 \
        --fetch-retry-mintimeout=20000 --fetch-retry-maxtimeout=180000 \
        "${offlineFlag[@]}" "${beforeFlag[@]}" "@deepseek-ai/dsh@$ver" \
      || die "内核安装失败（多为网络/镜像抖动；可重试或换镜像）。带 --npm-offline 时非 0 = **离线拿不到包，fail-closed 正确行为**。"
  fi
  local installed
  installed="$(kernel_version_of "$ver" 2>/dev/null || true)"
  [[ "$installed" == "$ver" ]] || die "内核版本校验失败：期望 $ver，实际 '${installed:-未装}'"

  # ---- 2) 依赖树形状自检（"全绿却跑不起来"事故的直接防线；判据同 setup.sh ensure_kernel）----
  local nested="$target/kernel/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-base/node_modules/@deepseek-ai"
  local nestedCount=0
  [[ -d "$nested" ]] && nestedCount="$(find "$nested" -mindepth 1 -maxdepth 1 | wc -l)"
  (( nestedCount == 0 )) || die "依赖树形状不对：dsh-base 下有 $nestedCount 个嵌套的 @deepseek-ai 包（应为顶层扁平）。
     这种树内核启动后会 crash-loop，且探针会误报全绿。
     修法：换一个你确认可用的 --npm-before 日期重装（见 setup.sh 头的 NPM_BEFORE_DEFAULT 说明）。"
  log "依赖树形状自检通过（顶层扁平）✓"

  # ---- 3) runtime 稳定路径自检（它决定 DSH_RUNTIME_ROOT，指错了插件全挂）----
  local rt="$target/$RUNTIME_REL"
  if [[ -f "$rt/@deepseek-ai/dsh-tools/package.json" ]]; then
    log "runtime 路径就位：$RUNTIME_REL（dsh-tools 在此）✓"
  else
    die "在 $RUNTIME_REL 下找不到 @deepseek-ai/dsh-tools。
     本脚本按 P6a 的实测落点写死该相对路径；若这次 npm 把它扁平化到了 kernel/lib/node_modules/
     （setup.sh ensure_kernel 是两种都探测的），说明落点变了 ⇒ **先拍板再继续**，不要手改 state.json。"
  fi

  # ---- 3b) 稳定软链 runtime（= /etc/dsh-remote.env 的 DSH_RUNTIME_ROOT 落点）----
  ensure_runtime_link

  # ---- 4) 自研插件快照（12 个纯目录；排除 node_modules）----
  local p name n=0
  for p in "$PLUGIN_SRC"/*/; do
    name="$(basename "${p%/}")"
    [[ "$name" == "node_modules" ]] && continue
    [[ -f "$p/package.json" ]] || continue
    run rsync -a --exclude node_modules "${p%/}" "$target/plugins/" \
      || die "快照插件失败：$name"
    n=$((n + 1))
  done
  (( n > 0 )) || die "没有快照到任何自研插件（$PLUGIN_SRC）"
  log "已快照 $n 个自研插件 → $target/plugins ✓"

  # ---- 4b) 宿主包接线（F1）----
  # 🔴 为什么必须有：插件经 pnpm link 以 **realpath** 落地，Node ESM 会从插件 realpath 逐级向上
  #    找 node_modules；release 快照里没有这条链 ⇒ 实测 `Cannot find package
  #    '@deepseek-ai/dsh-tools'`、`hotplug.autoload.done loaded=1 failed=14`。
  # 为什么用**相对**链：绝对链会绑死某一个 <ver>，翻 current 时不会跟着走；相对链随 current
  #    原子切换，且链与目标都在 release 内 ⇒ "release 只读"前提不破。
  # 为什么**只接 dsh-tools**：2026-09-26 逐 spec 实测（require.resolve）确认它是插件唯一
  #    "需要物理接线"的宿主包；`react` / `@deepseek-ai/dsh-client-ui-primitives` 同样
  #    "静态未解析"，但线上 15/15 全部加载正常 ⇒ 那两类由**宿主加载器的 externals** 提供。
  # 目标为什么是**嵌套**路径：dsh-tools 不是 dsh 的直接依赖（npm 不扁平化），实际落在
  #    <kernel>/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-tools。
  local scope="$target/plugins/node_modules/@deepseek-ai"
  run mkdir -p "$scope"
  run ln -sfn ../../../kernel/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-tools "$scope/dsh-tools"
  # ⚠️ dry-run 下 `run` 只打印不执行 ⇒ 这里不能断言"链已建好"
  if [[ "$DRY_RUN" != "1" ]]; then
    [[ -f "$scope/dsh-tools/package.json" ]] \
      || die "宿主包接线不可解析：$scope/dsh-tools/package.json（目标应为 <release>/<ver>/kernel/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-tools）"
    log "宿主包接线 @deepseek-ai/dsh-tools（相对链 → 本 release 的 kernel）✓"
  else
    log "[dry-run] 将建宿主包接线 @deepseek-ai/dsh-tools（相对链 → 本 release 的 kernel）"
  fi

  # ---- 5) profile 三键 + lockfile ----
  run install -m 0644 "$tpl" "$target/profile/package.json"
  local lock="$DSH_HOME/profiles/web/pnpm-lock.yaml"
  local ws="$DSH_HOME/profiles/web/pnpm-workspace.yaml"
  if [[ -f "$lock" ]]; then
    run install -m 0644 "$lock" "$target/profile/pnpm-lock.yaml"
    log "已存 lockfile 副本（第三方与 web-app 依赖树的钉点）✓"
  else
    warn "找不到 $lock —— release 里缺 lockfile。P-A/P-B 都依赖它，请人工确认。"
  fi
  # 🔴 F3：`pnpm-workspace.yaml` 必须与 lockfile **成对**搬运 —— `overrides` 住在 workspace
  #    文件里（本机实测：{'@deepseek-ai/dsh-settings': '0.1.6-alpha.2'}），lockfile 第 7 行起
  #    也记着同一份；只搬 lockfile ⇒ pnpm 认为"当前 overrides 配置 ≠ lockfile 记录的"并**拒绝**
  #    （实测报错：the current "overrides" configuration doesn't match the value found in the lockfile）。
  if [[ -f "$ws" ]]; then
    run install -m 0644 "$ws" "$target/profile/pnpm-workspace.yaml"
    log "已存 pnpm-workspace.yaml（与 lockfile 成对；含 overrides）✓"
  else
    warn "找不到 $ws ⇒ 第三方安装会因 overrides 不匹配被 pnpm 拒绝（F3）"
  fi

  # ---- 6) 权限：服务用户必须能"读 + 穿越"（读不到时内核只报 cannot resolve profile bundle）----
  if [[ "$DRY_RUN" != "1" ]]; then
    chown -R root:root "$target"
    # 🔴 P-A 方案 (a) 的前提：release 对**服务用户只读**（属主 root 可写；组/其他 r-x）。
    # 为什么必须"显式去掉写位"：`chmod -R a+rX` 只**加**读，**不会去掉**已有的组/其他写位；
    # 而"只读"正是"heal 想写就 EACCES ⇒ boot 崩"这道强保护的来源
    # （见 docs/superpowers/plans/2026-09-26-manual-whole-package-kernel-upgrade-design.md §②-9(b) 的实测块）。
    chmod -R u=rwX,go=rX "$target"
    if command -v runuser >/dev/null 2>&1; then
      runuser -u "$SERVICE_USER" -- test -r "$target/kernel/lib/node_modules/@deepseek-ai/dsh/package.json" \
        || die "服务用户 $SERVICE_USER 读不到 $target（权限/祖先目录）。内核只会报 cannot resolve profile bundle，不会提示权限问题。"
      log "服务用户可读性 ✓"
    fi
  fi

  # ---- 7) release.json（契约见整包式设计 §②-10）----
  local plugins_json third_json sha_blob now reljson
  # ⚠️ 必须排除 `node_modules`：4b) 的宿主包接线会把它建出来，不排除会让 pluginSet 多出
  #    一个 "node_modules" 条目（state.json 的 pluginSet 必须恰好是**插件集合**）。
  plugins_json="$( (cd "$target/plugins" && ls -1d */ 2>/dev/null | sed 's:/$::' | sed '/^node_modules$/d') | sort -u | lines_to_json_array)"
  third_json="$(node -e '
    const p = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))
    const out = Object.entries(p.dependencies || {})
      .filter(([k, v]) => !k.startsWith("@local/") && !/^(link|file):/.test(String(v)))
      .map(([k, v]) => ({ name: k, version: String(v) }))
    process.stdout.write(JSON.stringify(out))
  ' "$tpl")"
  sha_blob="$( (cd "$target" && find plugins -type f -print0 | sort -z | xargs -0 sha256sum) 2>/dev/null )"
  now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

  reljson="$(RUNTIME_REL="$RUNTIME_REL" node -e '
    const [coreVersion, npmBefore, nodeMin, profileTemplate, installedAt, treeShape, gitCommit, plugins, third, sha] = process.argv.slice(1)
    process.stdout.write(JSON.stringify({
      coreVersion, npmBefore, nodeMin, profileTemplate, installedAt,
      treeShape, gitCommit: gitCommit || null,
      runtimeRel: process.env.RUNTIME_REL,
      pluginSet: JSON.parse(plugins),
      pluginSha256: sha,
      thirdParty: JSON.parse(third),
      gatewayCommit: null,
      frontendCommit: null,
    }, null, 2) + "\n")
  ' "$ver" "$NPM_BEFORE" "22.15.0" "$PROFILE_TEMPLATE" "$now" "flat" "$GIT_COMMIT" "$plugins_json" "$third_json" "$sha_blob")"

  if [[ "$DRY_RUN" == "1" ]]; then
    log "[dry-run] 将写入 $target/release.json："
    printf '%s\n' "$reljson"
  else
    printf '%s' "$reljson" > "$target/release.json"
    chmod 0644 "$target/release.json"
  fi

  audit "update.install" "{\"version\":\"$ver\",\"npmBefore\":\"$NPM_BEFORE\",\"pluginCount\":$n}"
  log "✅ 已装成 release：$target"
  log "   ⚠️ **current 未翻转**（阶段 A.4 要求先证明"版本化本身不改变行为"）"
  log "   下一步：kernel-release.sh baseline --record  →  kernel-release.sh switch $ver"
}

# ----------------------------------------------------------------- status

cmd_status() {
  log "RELEASE_ROOT = $RELEASE_ROOT"
  if [[ -L "$CURRENT_LINK" ]]; then
    log "current -> $(readlink "$CURRENT_LINK")  （解析：$(readlink -f "$CURRENT_LINK" 2>/dev/null || echo '<断链>')）"
  elif [[ -e "$CURRENT_LINK" ]]; then
    warn "current 存在但**不是符号链接** —— 与设计不符"
  else
    log "current：**不存在**（版本化尚未首次落地）"
  fi
  if [[ -L "$RUNTIME_LINK" ]]; then
    log "runtime -> $(readlink "$RUNTIME_LINK")  （解析：$(readlink -f "$RUNTIME_LINK" 2>/dev/null || echo '<断链>')）"
  else
    log "runtime：**不存在**"
  fi

  echo
  echo "== 版本目录 =="
  local v found=0
  while read -r v; do
    [[ -n "$v" ]] || continue
    found=1
    printf '  %-24s coreVersion=%s\n' "$v" "$(rel_json "$v" coreVersion)"
    printf '  %-24s npmBefore=%s\n' "" "$(rel_json "$v" npmBefore)"
    printf '  %-24s plugins=%s\n' "" "$(rel_json "$v" pluginSet)"
    printf '  %-24s thirdParty=%s\n' "" "$(rel_json "$v" thirdParty)"
    printf '  %-24s installedAt=%s gitCommit=%s\n' "" "$(rel_json "$v" installedAt)" "$(rel_json "$v" gitCommit)"
  done < <(release_versions)
  (( found == 1 )) || echo "  （无：$RELEASE_ROOT 下还没有任何版本目录）"

  echo
  echo "== state.json =="
  if [[ -f "$STATE" ]]; then cat "$STATE"; else echo "  （不存在）"; fi

  echo
  echo "== 部署体侧现状（只读，用于对账）=="
  local lnk
  for lnk in "$DSH_HOME"/profiles/web/node_modules/@local/*; do
    [[ -L "$lnk" ]] || continue
    printf '  @local/%-18s -> %s\n' "$(basename "$lnk")" "$(readlink -f "$lnk" 2>/dev/null || echo '<断链>')"
  done
  echo "  ⚠️ 上面若指向 /opt/dsh-remote/plugins/** 而非 $RELEASE_ROOT/current/plugins/**，"
  echo "     说明"一次性迁移"（§⑤#14）尚未做 ⇒ 切包时**不是原子**的（12 条要逐个改）。"

  echo
  echo "== 现役内核（未被 release 目录接管时仍是它）=="
  local g; g="$(npm root -g 2>/dev/null || true)"
  [[ -n "$g" ]] && printf '  npm root -g = %s\n' "$g"
  printf '  %s NRestarts=%s\n' "$KERNEL_UNIT" "$(nrestarts)"
}

# ----------------------------------------------------------------- baseline

cmd_baseline() {
  local record=0
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --record) record=1; shift ;;
      *) die "baseline 未知参数：$1" ;;
    esac
  done
  need_cmd node
  [[ -f "$CHECK_READY" ]] || die "找不到 check-ready.sh：$CHECK_READY"

  log "跑一次 check-ready.sh（约 15 s，含二次采样）…"
  local failset n
  failset="$(check_ready_fail_set)"
  n="$(printf '%s\n' "$failset" | grep -c . || true)"
  echo "-- FAIL 行集合（数字已归一化为 N）--"
  if [[ -n "$failset" ]]; then printf '%s\n' "$failset" | sed 's/^/  /'; else echo "  （无 FAIL）"; fi
  echo "  ⚠️ WARN 不参与判定（它的数量随内核运行时长变化，不是常量）"

  if (( record == 1 )); then
    [[ -d "$RELEASE_ROOT" ]] || die "--record 需要 $RELEASE_ROOT 已存在（先 install）"
    local arr at
    at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    arr="$(printf '%s\n' "$failset" | lines_to_json_array)"
    state_patch "{\"baseline\":{\"fail\":$arr,\"at\":\"$at\",\"nrestarts\":\"$(nrestarts)\"}}"
    log "已写入 state.json.baseline（$at，$n 条 FAIL）"
  else
    log "（未加 --record，未落盘）"
  fi
}

# ----------------------------------------------------------------- switch

cmd_switch() {
  local ver="${1:-}"; [[ -n "$ver" ]] && shift || true
  local skip_gate=0
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --force)     FORCE=1; skip_gate=1; shift ;;
      --skip-gate) skip_gate=1; shift ;;
      *) die "switch 未知参数：$1" ;;
    esac
  done
  [[ -n "$ver" ]] || die "switch 需要 <ver>"
  [[ "$ver" != */* ]] || die "<ver> 不能含 /"
  require_root
  need_cmd node
  [[ -d "$RELEASE_ROOT/$ver" ]] || die "该版本目录不存在：$RELEASE_ROOT/$ver（先 install）"
  [[ -f "$RELEASE_ROOT/$ver/release.json" ]] || die "缺 release.json：$RELEASE_ROOT/$ver（先 install）"
  [[ "$(rel_json "$ver" coreVersion)" == "$ver" ]] || die "release.json.coreVersion ≠ $ver（盘上不一致，拒绝切换）"

  local frozen; frozen="$(state_field frozen)"
  [[ "$frozen" != "true" ]] || refuse "state.json.frozen=true（安全模式）：不再做任何切换，需人工 reset。"

  local cur curname
  cur="$(readlink -f "$CURRENT_LINK" 2>/dev/null || true)"
  curname="$(basename "${cur:-none}")"
  if [[ "$curname" == "$ver" ]] && [[ "$(state_field phase)" == "ok" ]]; then
    log "current 已指向 $ver 且 phase=ok ⇒ **空操作**（幂等）"
    return 0
  fi

  # ---- 前置：服务用户可读性（读不到时内核只报 cannot resolve profile bundle）----
  if command -v runuser >/dev/null 2>&1; then
    runuser -u "$SERVICE_USER" -- test -r "$RELEASE_ROOT/$ver/kernel/lib/node_modules/@deepseek-ai/dsh/package.json" \
      || die "服务用户 $SERVICE_USER 读不到 $ver 的内核（权限/祖先目录）⇒ 拒绝切换"

    # ---- 前置：🔴 P-A 方案 (a) 的硬前提 —— release 对服务用户**只读** ----
    # 为什么是硬前提：只读 ⇒ 内核 heal 只要想写就必然 EACCES ⇒ boot 崩
    # ⇒ "起得来"本身就成了「heal 零写入」的必要条件（详见 docs 的 P-A 实测块 §②-9(b)）。
    # 一旦可写，这道强保护失效，「快照 = 只读纯代码」的前提也不再成立。
    if command -v find >/dev/null 2>&1; then
      local writable
      writable="$(runuser -u "$SERVICE_USER" -- find "$RELEASE_ROOT/$ver" -writable -print -quit 2>/dev/null || true)"
      [[ -z "$writable" ]] || die "release 里有**服务用户可写**的路径：$writable
     ⇒ 违反 P-A 方案 (a) 的只读前提。修法：
       chown -R root:root $RELEASE_ROOT/$ver && chmod -R u=rwX,go=rX $RELEASE_ROOT/$ver"
      log "只读前提自检 ✓（release 内无服务用户可写路径）"
    fi
  fi

  audit "update.switch.begin" "{\"from\":\"$curname\",\"to\":\"$ver\",\"force\":$FORCE}"

  # ---- 1) 门闸：复用 restart-kernel.sh 的**同一端点、同一 fail-closed 口径** ----
  if (( skip_gate == 1 )); then
    warn "--force/--skip-gate：跳过门闸判定（**留痕**）"
    audit "update.gate_skipped" '{"reason":"--force/--skip-gate"}'
  else
    local out rc
    out="$(bash "$RESTART_KERNEL" --check 2>&1)"; rc=$?
    printf '%s\n' "$out" >&2
    case "$rc" in
      0) log "门闸判定：safe ✓" ;;
      2) refuse "门闸判定**不安全**（有在飞 turn / 委派 / 热拔插）⇒ 拒绝切换。明细见上。若非切不可：switch --force（留痕）。" ;;
      *) no_judgement "**取不到判定**（门闸端点不可用，HTTP 非 200）⇒ fail-closed，拒绝切换。明细见上。" ;;
    esac
  fi

  local snap; snap="$(gate_snapshot)"
  log "门闸快照（事后说明"这次重启掐断了什么"）：$snap"
  audit "update.gate_snapshot" "$snap"

  # ---- 2) 基线：此刻的 FAIL 集合 + NRestarts（verify 的差分基准）----
  local failset nrs0 at arr
  failset="$(check_ready_fail_set)"
  nrs0="$(nrestarts)"
  at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  arr="$(printf '%s\n' "$failset" | lines_to_json_array)"
  state_patch "{\"baseline\":{\"fail\":$arr,\"at\":\"$at\",\"nrestarts\":\"$nrs0\"}}"
  log "基线已记：NRestarts=$nrs0，FAIL $(printf '%s\n' "$failset" | grep -c . || true) 条"

  # ---- 3) 原子翻转（同文件系统 rename(2) ⇒ 读者只看得到完整旧链或完整新链）----
  #      TODO(§⑤#14/#15)：若拍板"@local/* 指向 current"与 P-A，则此处还要把
  #      profiles/web/node_modules 改成指向 <release>/profile/node_modules。两者都是**一次性**迁移，
  #      不在每次切包里重复。
  run ln -sfn "$RELEASE_ROOT/$ver" "$RELEASE_ROOT/current.new"
  run mv -Tf "$RELEASE_ROOT/current.new" "$CURRENT_LINK"
  audit "update.switch.link_flipped" "{\"from\":\"$curname\",\"to\":\"$ver\"}"

  # ---- 4) 重启（P6a：这是 restart-kernel.sh 之外的第二处重启入口；第 1 步刚判定 safe）----
  run systemctl restart "$KERNEL_UNIT" || die "systemctl restart $KERNEL_UNIT 失败"

  # ---- 5) phase=verifying（兜"翻完链就崩"的半完成态）----
  local pset
  pset="$(rel_json "$ver" pluginSet)"
  state_patch "{\"current\":\"$ver\",\"phase\":\"verifying\",\"switchedAt\":\"$at\",\"from\":\"$curname\",\"nrestartsAtSwitch\":\"$nrs0\",\"pluginSet\":${pset:-[]}}"
  log "已置 phase=verifying（switchedAt=$at）"

  log "✅ 切换完成：$curname → $ver"
  log "   下一步：等 **T+150 s**（历史崩点 91–122 s，必须跨过）后跑  kernel-release.sh verify"
}

# ----------------------------------------------------------------- verify

cmd_verify() {
  local window=150 pa_checks=1
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --window) window="${2:-150}"; shift 2 ;;
      --no-pa)  pa_checks=0; shift ;;
      *) die "verify 未知参数：$1" ;;
    esac
  done
  need_cmd node; need_cmd curl
  local phase switchedAt
  phase="$(state_field phase)"
  [[ -n "$phase" ]] || die "state.json 里没有 phase（先 switch，或本机还没做过版本化）"
  switchedAt="$(state_field switchedAt)"

  local failed=0 hits=()
  log "phase=$phase · switchedAt=${switchedAt:-<无>} · 观察下限=${window}s"

  # ---- H1：NRestarts 在窗口内增长（它只在**自动重启逻辑**生效时增长；手工 restart 会清零）----
  local nrs0 nrs1
  nrs0="$(state_field baseline.nrestarts)"; [[ -n "$nrs0" ]] || nrs0="$(state_field nrestartsAtSwitch)"
  nrs1="$(nrestarts)"
  if [[ -n "$nrs0" && -n "$nrs1" ]] && (( nrs1 > nrs0 )); then
    err "H1 ✗ NRestarts 由 $nrs0 增到 $nrs1 ⇒ 内核**自己挂过**"; hits+=(H1); failed=1
  else
    log "H1 ✓ NRestarts=${nrs1:-?}（切换时 ${nrs0:-?}）"
  fi

  # ---- H2：撞 V8 堆上限 / 致命错误 ----
  local h2=0
  if [[ -n "$switchedAt" ]]; then
    h2="$(journalctl -u "$KERNEL_UNIT" --since "$switchedAt" --no-pager 2>/dev/null \
           | grep -cE 'Reached heap limit|FATAL ERROR' || true)"
  fi
  if [[ "${h2:-0}" -gt 0 ]]; then
    err "H2 ✗ 窗口内出现 ${h2} 次 'Reached heap limit|FATAL ERROR'"; hits+=(H2); failed=1
  else
    log "H2 ✓ 无堆上限/FATAL"
  fi

  # ---- H3：内核端口不通（⚠️ HTTP **401 是正常的** —— 判据是"非 000"，不是 200）----
  local code listening=0
  if command -v ss >/dev/null 2>&1 && ss -ltn 2>/dev/null | grep -q ":${KERNEL_PORT}"; then listening=1; fi
  code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:${KERNEL_PORT}/" 2>/dev/null || echo 000)"
  if (( listening == 0 )) || [[ "$code" == "000" ]]; then
    err "H3 ✗ 内核端口不通（监听=$listening，HTTP=$code）"; hits+=(H3); failed=1
  else
    log "H3 ✓ :${KERNEL_PORT} 在监听，HTTP=$code（401 属正常）"
  fi

  # ---- H4/A9 + H5/A10：P-A 方案 (a) 的两条硬验收（--no-pa 可跳过；P-B/P-C 不适用）----
  if (( pa_checks == 1 )); then
    # H4/A9：落在 **release 或 profiles/*/node_modules 上**的 fallback / 权限类错误必须为 0。
    #   原理：release 对服务用户只读 ⇒ heal 想写 release 就必然 EACCES ⇒ boot 崩
    #   ⇒ "起得来"本身已是"零写入"的必要条件（H5/A10 补充分面）。
    # 🔴 口径修正（2026-09-26，G4）：原口径"只看提及 $RELEASE_ROOT 的行"**会漏报** ——
    #   夹具 B-3/B-4 实测：heal 写失败时报错文本写的是 **DSH_HOME 侧路径**，不含 release 字面
    #   ⇒ 旧口径永远判 ✓。现改为**两个路径域任一命中即计入**（见 `a9_hits()` 的注释）。
    #   原"收紧"的理由仍然成立：成功写入不留 EACCES 行 ⇒ 不会把正常的 ~163 条软链重建误判。
    local h4hit=0 h4rel=0 h4all=0 logtxt
    if [[ -n "$switchedAt" ]]; then
      logtxt="$(journalctl -u "$KERNEL_UNIT" --since "$switchedAt" --no-pager 2>/dev/null || true)"
      h4all="$(printf '%s\n' "$logtxt" | grep -cE 'EACCES|EPERM|exists and is not a symlink' || true)"
      h4hit="$(printf '%s\n' "$logtxt" | a9_hits "$RELEASE_ROOT")"
      h4rel="$(printf '%s\n' "$logtxt" | grep -E 'EACCES|EPERM|exists and is not a symlink' | grep -cF "$RELEASE_ROOT" || true)"
    fi
    if [[ "${h4hit:-0}" -gt 0 ]]; then
      err "H4/A9 ✗ 窗口内出现 ${h4hit} 条**落在 release 或 profiles/*/node_modules 上**的 fallback/权限类错误（其中提及 $RELEASE_ROOT 的 ${h4rel:-0} 条）⇒ 只读快照被触碰 ⇒ P-A 前提不成立"; hits+=(H4); failed=1
    else
      log "H4/A9 ✓ 无落在 release / profiles/*/node_modules 上的 fallback·权限类错误（heal 未试图写 release）"
      if [[ "${h4all:-0}" -gt 0 ]]; then
        warn "  参考：窗口内另有 ${h4all} 条**其它路径**的权限类错误，均与 release 及 profiles/*/node_modules 无关 ⇒ 不计入 A9；若反复出现值得单独查"
      fi
    fi

    # H5/A10：**仅当 P-A 已应用**才判定 —— P-A 已应用 ⇔ profiles/web/node_modules 本来就是软链。
    #   未应用（首次"版本化演练"就是这种情况）⇒ 记 N/A，**不判失败**；
    #   否则会把"还没做 §⑤#15 迁移"误判成"切换不通过" ⇒ 无谓回滚（2026-09-26 修正）。
    #   ⚠️ 一旦 P-A 已应用，这里就是硬判据：软链必须仍在、且仍指向目标 release（= 没被实体化/替换）。
    local pnm="$DSH_HOME/profiles/web/node_modules" cur got
    cur="$(state_field current)"
    if [[ ! -L "$pnm" ]]; then
      log "H5/A10 ○ N/A：profiles/web/node_modules 不是软链 ⇒ P-A（§⑤#15）尚未应用，本条不适用（**不计失败**）"
    else
      got="$(readlink -f "$pnm" 2>/dev/null || true)"
      if [[ -n "$cur" && "$got" == "$RELEASE_ROOT/$cur/profile/node_modules" ]]; then
        log "H5/A10 ✓ 仍是软链，且指向 $cur/profile/node_modules"
      else
        err "H5/A10 ✗ 指向 '$got'，期望 '$RELEASE_ROOT/${cur:-<current>}/profile/node_modules'"; hits+=(H5); failed=1
      fi
    fi
  else
    warn "已跳过 P-A 专属判据（H4/A9、H5/A10）—— 你给了 --no-pa"
  fi

  # ---- R：check-ready 的 **FAIL 基线差分**（只回滚"新版新增的 FAIL"；**不看 WARN**）----
  local base now new
  base="$(state_field baseline.fail)"
  now="$(check_ready_fail_set)"
  new="$(printf '%s\n' "$now" | node -e '
    const base = JSON.parse(process.argv[1] || "[]")
    let r = ""
    process.stdin.on("data", (c) => { r += c })
    process.stdin.on("end", () => {
      const now = r.split("\n").map((s) => s.trim()).filter(Boolean)
      process.stdout.write(now.filter((x) => !base.includes(x)).join("\n"))
    })
  ' "${base:-[]}")"
  if [[ -n "$new" ]]; then
    err "R ✗ 出现**基线之外的新 FAIL**："; printf '%s\n' "$new" | sed 's/^/     /' >&2
    hits+=(R); failed=1
  else
    log "R ✓ FAIL 无新增（基线内 $(printf '%s\n' "$now" | grep -c . || true) 条属既有噪声）"
  fi

  if (( failed == 0 )); then
    audit "update.verify.pass" "{\"phase\":\"$phase\",\"window\":$window}"
    state_patch "{\"phase\":\"ok\",\"verifiedAt\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}"
    log "✅ verify 通过（phase → ok）"
    log "   ⚠️ 这只证明"程序起来了"；**UQ3（跨版本回读旧会话）自动判据答不了** ⇒"
    log "     请按整包式设计 §②-4(c) 手工做"A→B→A 回环读"。"
    return 0
  fi
  audit "update.verify.fail" "{\"phase\":\"$phase\",\"hits\":\"${hits[*]}\"}"
  err "❌ verify 未通过（命中：${hits[*]}）"
  err "   处置：kernel-release.sh rollback（回滚路径**必须** --force，见头部铁律 2）"
  return 2
}

# ----------------------------------------------------------------- rollback

# "数据是否已被新版写过"（P6a ②-2(B)）—— 只判"有没有"，**不做任何修复**
evidence_of_new_writes() {
  local switchAt="$1" n=0 f
  [[ -n "$switchAt" ]] || { echo "unavailable"; return 0; }
  [[ -d "$DSH_HOME/sessions" ]] || { echo "unavailable"; return 0; }
  n="$(find "$DSH_HOME/sessions" -name 'session*.jsonl.zstd' -newermt "$switchAt" 2>/dev/null | wc -l)"
  printf 'sessionFilesWrittenSinceSwitch=%s\n' "$n"
  # ⚠️ 排除两项：每次 boot 必被内核重写，**不算证据**
  #    profiles/web/cordis.yml · profiles/web/.dsh-module-fallback/
  for f in hotplug-manifest.yml storages/workspace.json settings.yaml \
           profiles/web/package.json profiles/web/pnpm-lock.yaml; do
    [[ -f "$DSH_HOME/$f" ]] && stat -c '%y %n' "$DSH_HOME/$f"
  done
}

cmd_rollback() {
  local to=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --to) to="${2:-}"; shift 2 ;;
      --accept-data-risk) ACCEPT_DATA_RISK=1; shift ;;
      --dry-run) DRY_RUN=1; shift ;;
      *) die "rollback 未知参数：$1" ;;
    esac
  done
  require_root
  need_cmd node
  [[ -n "$to" ]] || to="$(state_field from)"
  [[ -n "$to" && "$to" != "none" ]] || die "不知道该回滚到哪：请给 --to <ver>（state.json.from 为空）"
  [[ -d "$RELEASE_ROOT/$to" ]] || die "目标版本目录不存在：$RELEASE_ROOT/$to（没有回滚目标，就只能重装或整机快照回滚）"

  local cur; cur="$(basename "$(readlink -f "$CURRENT_LINK" 2>/dev/null || echo none)")"
  [[ "$cur" != "$to" ]] || { log "current 已经是 $to ⇒ 空操作"; return 0; }

  # ---- 1) 数据判定：有 ⇒ 默认**拦住**（"程序退回去了、数据退不回去"是静默形态）----
  local switchAt ev
  switchAt="$(state_field switchedAt)"
  ev="$(evidence_of_new_writes "$switchAt")"
  log "数据判定（switchAt=${switchAt:-<无>}）："
  printf '%s\n' "$ev" | sed 's/^/   /'
  if [[ "$ev" == "unavailable" ]]; then
    no_judgement "**取不到数据判定证据**（拿不到 DSH_HOME/sessions 的 mtime）⇒ fail-closed：拒绝回滚，交人。"
  fi
  if printf '%s' "$ev" | grep -qE 'sessionFilesWrittenSinceSwitch=[1-9]'; then
    if (( ACCEPT_DATA_RISK == 1 )); then
      warn "--accept-data-risk：已知新版写过会话文件，仍继续（回滚后**必须**做 §②-4(c) 的 UQ3 回环读）"
    else
      refuse "新版**已写过**格式敏感文件 ⇒ 可能"程序退回去、数据退不回去"。
     请先手工评估，确认要承担后果后再加 --accept-data-risk 重跑。"
    fi
  fi

  audit "update.rollback.begin" "{\"from\":\"$cur\",\"to\":\"$to\",\"acceptDataRisk\":$ACCEPT_DATA_RISK}"

  # ---- 2) 翻回旧链接（原子；TODO §②-9(b)：P-A 下第三方随 current 一起回，P-B 下需反向 pnpm install）----
  run ln -sfn "$RELEASE_ROOT/$to" "$RELEASE_ROOT/current.new"
  run mv -Tf "$RELEASE_ROOT/current.new" "$CURRENT_LINK"

  # ---- 3) 🔴 必须 --force：新包起不来时门闸端点（住在内核进程里）也不可用 ⇒ 正常路径 exit 3 ----
  if [[ "$DRY_RUN" == "1" ]]; then
    log "[dry-run] bash $RESTART_KERNEL --force"
  else
    bash "$RESTART_KERNEL" --force || warn "restart-kernel.sh --force 返回非 0 —— 请人工确认单元状态"
  fi

  # ---- 4) 状态 + 审计（rollbackCount 上限是 P6a 阶段 B 的概念；手工版只如实累加）----
  local rc0 count
  rc0="$(state_field rollbackCount)"; count=$(( ${rc0:-0} + 1 ))
  state_patch "{\"current\":\"$to\",\"from\":\"$cur\",\"phase\":\"verifying-rollback\",\"rollbackAt\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"rollbackCount\":$count}"
  audit "update.rollback.done" "{\"from\":\"$cur\",\"to\":\"$to\",\"rollbackCount\":$count}"

  log "✅ 已回滚：$cur → $to（rollbackCount=$count）"
  log "   下一步：① 等 T+150 s 跑  kernel-release.sh verify；"
  log "           ② 插件侧 C 栏（§②-4(b)）：readlink -f @local/* 12 条 == $to、report-hotplug-mounts loaded=N failed=0、无新增 missing；"
  log "           ③ 抽样打开旧会话 + 新包写过的新会话（UQ3）；"
  log "           ④ 白名单**不随包回** ⇒ 若新 release 曾加过插件，用 hotplug API 把多余条目 enabled:false/remove。"
}

# ----------------------------------------------------------------- main

CMD="${1:-}"; [[ $# -gt 0 ]] && shift || true
# ------------------------------------------------------------------------- selftest
# A9（H4）判据的**正反例自测**：用合成日志喂纯函数 `a9_hits()`。
#   **不碰 journalctl、不碰服务器、不需要 root。**
# 为什么必须有它：A9 是**硬门闸**，而它曾经是一条"永远返回 ✓"的判据
#   （旧口径只 grep release 字面，而真实的报错文本里没有该字面 —— 见 `a9_hits()` 注释）
#   ⇒ 不证明"该命中时会命中"，就无法排除"又一个空门闸"。
# 用法：bash deploy/linux/kernel-release.sh selftest
cmd_selftest() {
  local rel='/usr/local/dsh-release/0.1.5-rc.1'
  local pass=0 fail=0

  # 注意：必须把日志文本**当参数传**，不能用 `… | t`。
  #   原因：管道里每个命令都在子 shell 执行 ⇒ 管道形式下 `pass++` 会丢。
  t() {  # t <期望命中数> <名称> <日志文本>
    local want="$1" name="$2" text="$3" got
    got="$(printf '%s\n' "$text" | a9_hits "$rel")"
    if [[ "${got:-0}" == "$want" ]]; then
      printf '  ✅ %s（命中 %s）\n' "$name" "$got"; pass=$((pass+1))
    else
      printf '  ❌ %s：期望 %s，实得 %s\n' "$name" "$want" "${got:-?}"; fail=$((fail+1))
    fi
  }

  printf '%s\n' '— 必须命中（反例：release 被触碰的真实形态）—'
  t 1 '夹具 B-3 形态：缺条目 ⇒ 报错写的是 DSH_HOME 侧路径，**不含 release 字面**（旧口径会漏报）' \
    "EACCES: permission denied, symlink '../profile/node_modules/dep-x' -> '/srv/dsh-home/profiles/web/node_modules/dep-x'"
  t 1 '夹具 B-4 形态：多条目 ⇒ unlink，同样不含 release 字面' \
    "Error: EACCES: permission denied, unlink '/srv/dsh-home/profiles/web/node_modules/extra-y'"
  t 1 'release 字面直接出现' \
    "EACCES: permission denied, open '$rel/profile/node_modules/z'"
  t 1 '内核特有的 "exists and is not a symlink"' \
    "Error: 'x' exists and is not a symlink at /srv/dsh-home/profiles/web/node_modules/x"

  printf '%s\n' '— 必须不命中（正例：避免误判 ⇒ 白回滚）—'
  t 0 '切包瞬间正常的 ~163 条软链重建（成功写入 ⇒ 不留 EACCES 行）' \
    'info: rebuilt symlink /srv/dsh-home/profiles/node_modules/@deepseek-ai/dsh -> /usr/local/dsh-release/current/kernel/lib/node_modules/@deepseek-ai/dsh'
  t 0 '无关路径的 EACCES' \
    'EACCES: permission denied, open /etc/dsh-remote.env'
  t 0 '非权限类错误（EEXIST）—— 本判据只管 EACCES/EPERM/exists and is not a symlink' \
    "Error: EEXIST: file already exists, symlink 'a' -> '/srv/dsh-home/profiles/web/node_modules/b'"
  t 0 '无路径的裸 EPERM ⇒ 不计（保持原有收紧口径）' \
    'EPERM: operation not permitted'
  t 0 '空日志' \
    ''

  printf '\n  A9 selftest 合计：pass=%s fail=%s\n' "$pass" "$fail"
  if [[ "$fail" -eq 0 ]]; then
    log "✅ A9 判据自测通过（${pass} 条）"
  else
    err "🔴 A9 判据自测失败（${fail} 条）—— 门闸不可信，修好再用于切换判定"
    return 1
  fi
}

ARGS=()
for a in "$@"; do
  if [[ "$a" == "--dry-run" ]]; then DRY_RUN=1; else ARGS+=("$a"); fi
done

case "$CMD" in
  selftest) cmd_selftest ;;
  install)  cmd_install  "${ARGS[@]+"${ARGS[@]}"}" ;;
  status)   cmd_status ;;
  baseline) cmd_baseline "${ARGS[@]+"${ARGS[@]}"}" ;;
  switch)   cmd_switch   "${ARGS[@]+"${ARGS[@]}"}" ;;
  verify)   cmd_verify   "${ARGS[@]+"${ARGS[@]}"}" ;;
  rollback) cmd_rollback "${ARGS[@]+"${ARGS[@]}"}" ;;
  -h|--help|"") usage; exit 0 ;;
  *) die "未知子命令：$CMD（用 --help 看用法）" ;;
esac
