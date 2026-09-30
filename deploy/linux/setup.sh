#!/usr/bin/env bash
# dsh-remote —— Linux 侧落地脚本（首次部署，可幂等重跑）
#
# 做什么：
#   1) 校验 Node（>=22.15，zstd API 需要）；--install-node 时才从国内镜像安装
#   2) 全局安装内核 @deepseek-ai/dsh@<与本地相同版本>（官方 npm 作用域 @deepseek-ai/*）
#   3) 建目录 + 服务用户，生成 /etc/dsh-remote.env（路径类环境变量）
#   4) 落最小插件集：setup.mjs + profile-web-minimal.package.json（base + web-app + adapter + memory-system）
#   5) 安装 systemd unit（内核、网关各一个），并做一次静态自检
#   6) 落 journald 容量上限 drop-in（journald 默认上限 = 盘的 10%，40 GB 盘上就是 4 GB）
#
# 不做什么：不改 apt 源、不动防火墙/安全组、不 enable/start 服务（只在最后打印命令，让你先手动验证）。
#
# 用法（需 root）：
#   sudo deploy/linux/setup.sh                                  # 用默认路径
#   sudo deploy/linux/setup.sh --workspace-root /srv/dsh-workspace
#   sudo deploy/linux/setup.sh --install-node --node-version 22.19.0
#   sudo deploy/linux/setup.sh --no-units                       # 只落数据与插件，不碰 systemd
#
# 幂等：重复执行只补齐缺失项；已存在的配置文件不会被覆盖。
set -euo pipefail

# ---------- 默认值（全部可用同名长参数覆盖）----------
DSH_HOME_DEFAULT="/srv/dsh-home"
WORKSPACE_ROOT_DEFAULT="/srv/dsh-workspace"
SERVICE_USER="dsh"
# 🟢 默认内核版本 = **服务器现役版本**（2026-09-27 首次真升级后：rc.1 → rc.3）。
#    🔴 它必须与 `NPM_BEFORE_DEFAULT` **成对**（"某版本 + 该版本发布后、下一版发布前的钉点"）。
#    只改一个 ⇒ 会装出"新版内核 + 旧版期传递依赖"（或反之）的**混搭树**。
#    按版本登记：`0.1.5-rc.1 → 2026-09-10T12:00:00Z`；`0.1.5-rc.3 → 2026-09-22T16:00:00Z`。
#    ⇒ 若要用**非默认版本**部署，请**同时**显式传 `--npm-before`（见下方 NPM_BEFORE_DEFAULT 的说明）。
DSH_VERSION="0.1.5-rc.3"
PROFILE_TEMPLATE="profile-web-minimal.package.json"
NPM_MIRROR="https://registry.npmmirror.com"
# 🟢 pnpm 版本：**唯一真源 = 仓库根 `package.json` 的 `packageManager`**（2026-09-26 起）。
#    为什么改成"读"而不是"写死"：写死 `PNPM_VERSION = "12.5.1"` 与 `packageManager` 并存就是
#    **双真源** ⇒ 必然漂移（Spec② R4）。改版本只改 `package.json` 一处。
#    ⚠️ `command -v pnpm` 在 WSL2 会命中 Windows 垫片（/mnt/c/...，实测），
#       在服务器会找不到（不在 ssh 非登录 shell 的 PATH 里）—— **别据此判断"没装 pnpm"**；
#       查版本一律用绝对路径：`"$(npm prefix -g)/bin/pnpm" --version`。
#    ⚠️ 本机 WSL2 实测：全局那份 pnpm 的**原生二进制已损坏**（`--version` ⇒ SIGSEGV，rc 139）。
#       修法见 assemble-release.sh 的 --pnpm-bin 提示。
PNPM_VERSION=""   # 由 main 里 pnpm_pinned_version() 赋值（真源见上）
NODE_VERSION="22.19.0"
NODE_MIN="22.15.0"
# 把**传递依赖**的解析钉到一个已知可用的时刻。
#
# 为什么必须钉（2026-09-23 干净实例实测的事故根因）：
#   `@deepseek-ai/dsh@0.1.5-rc.1` 的传递依赖是 `^` 范围。上游持续发版，
#   全新安装会解析到更新的传递版本（实测当天已是 dsh-base@0.1.5-rc.3）。
#   而**传递版本一变，npm 生成的依赖树形状就变**（顶层扁平 ↔ 嵌套），
#   内核的插件加载器**要求扁平形状** —— 树一变嵌套，启动后就 crash-loop：
#     plugin(s) failed to load: @deepseek-ai/dsh-sandbox-local;
#     Cordis startup failed because these plugin(s) could not be resolved
#   ⇒ 同一台机器、同一条命令，"昨天装能跑、今天装就跑不起来"，且**探针会报全绿**
#     （内核崩溃前那几秒确实在监听）。
#
# 规则 = 取"**该版本发布后、下一版发布前**"的中间点，且**必须晚于该版本依赖链上
#        更晚发布的包**（否则那些包会被 --before 挡掉 ⇒ ETARGET 装不出来）。
#   实测的内核发布时刻：
#     rc.1  → 2026-09-10T03:02~03:12Z
#     rc.2  → 2026-09-10T14:46~14:57Z
#     rc.3  → 2026-09-22T05:55:20Z
#
# ✅ 已登记的取值（**按内核版本登记**；本常量默认 = 最新一版）：
#     0.1.5-rc.1 → 2026-09-10T12:00:00Z   （落在 rc.1 / rc.2 之间）实测：
#       dsh=0.1.5-rc.1  dsh-base=0.1.5-rc.1  dsh-session=0.1.5-rc.1
#       内核顶层呈扁平、is-active=active、NRestarts=0、3080 正常监听
#     0.1.5-rc.3 → 2026-09-22T16:00:00Z
#
# 🔴 升级内核版本时**必须**同步更新本常量，否则 ETARGET（rc.3 实测）：
#   rc.3 发布于 2026-09-22T05:55:20Z，**晚于**旧钉点 2026-09-10T12:00:00Z ⇒ npm 报
#     `ETARGET: No matching version found for @deepseek-ai/dsh@0.1.5-rc.3
#      with a date before 9/10/2026`（在 install_kernel 阶段即失败）。
#   ⚠️ 也**不能只取"发布后一点"**：rc.3 依赖链上有更晚发布的
#     `@deepseek-ai/dsh-client-ui-sidebar-documentpreview@0.1.5-rc.3 = 2026-09-22T12:45:59Z`
#     （用 2026-09-22T06:09:00Z 试过 ⇒ 仍 ETARGET）。最终取 2026-09-22T16:00:00Z
#     （排在 0.1.7-alpha.2 = 16:08Z 之前）。
#
# ⚠️ 本钉点与 --dsh-version **成对**（一个内核版本一个钉点）：默认值当前取最新版 rc.3 的，
#   而 DSH_VERSION 默认仍是 0.1.5-rc.1 ⇒ 若按 rc.1 部署，请显式传
#   `--npm-before 2026-09-10T12:00:00Z`（否则会解析到 rc.3 期的传递依赖 ⇒ 树形状不对）。
#
# ⚠️ 这不是"额外要求"，而是与第三方插件的约束**同一个**：
#   `@nanmicoder/dsh-agent-teams`（含最新版 0.1.20）的 peer 精确枚举 `0.1.5-rc.1`
#   —— 它的 README 把 `0.1.5-rc.1` 列为 recommended host。把传递依赖钉到 rc.1，
#   正是让**宿主整棵树**都落在插件声明的范围内。
NPM_BEFORE_DEFAULT="2026-09-22T16:00:00Z"
INSTALL_NODE=0
INSTALL_UNITS=1

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DSH_HOME="$DSH_HOME_DEFAULT"
WORKSPACE_ROOT="$WORKSPACE_ROOT_DEFAULT"
NPM_BEFORE="$NPM_BEFORE_DEFAULT"   # 空串 = 不钉（见上面 NPM_BEFORE_DEFAULT 的说明）
RUNTIME_ROOT=""      # 由 ensure_kernel 赋值（npm root -g；release 模式下 = <release>/runtime）
NPM_GLOBAL_BIN=""    # 由 ensure_global_bin 赋值（npm prefix -g + /bin）
RELEASE_ROOT=""      # 🔴 空 = 现行为（原地覆盖式装全局包）；非空 = **release 模式**（P6a 阶段 A.2 草案）
                     #   由 --release-root <dir> 开启（推荐 /usr/local/dsh-release）。
                     #   ⚠️ 默认**必须**保持空：改了默认值会让现有部署的行为突变
                     #      （内核被装到别处 + unit PATH 指向 current + env 被改写）。

log()  { printf '\033[36m[setup]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[setup]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[31m[setup] %s\033[0m\n' "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
dsh-remote —— Linux 侧落地脚本（首次部署，可幂等重跑）

做什么：
  1) 校验 Node（>=22.15，zstd API 需要）；--install-node 时才从国内镜像安装
  2) 全局安装内核 @deepseek-ai/dsh@<与本地相同版本>
  3) 建目录 + 服务用户，生成 /etc/dsh-remote.env（路径类环境变量）
  4) 落最小插件集：setup.mjs + profile-web-minimal.package.json
     （base + web-app + dsh-adapter + memory-system）
  5) 安装 systemd unit（内核、网关各一个）
  6) 落 journald 容量上限 drop-in（需手动重启 journald 才生效）

不做什么：不改 apt 源、不动防火墙/安全组、不 enable/start 服务（打印命令，先手动验证）。

可覆盖参数：
  --dsh-home <dir>            DSH_HOME（默认 /srv/dsh-home）
  --workspace-root <dir>      工作区根（默认 /srv/dsh-workspace，注入 DSH_WORKSPACE_ROOT）
  --user <name>               运行服务的系统用户（默认 dsh，不存在则创建）
  --dsh-version <ver>         内核版本（默认 0.1.5-rc.1，必须与本机一致）
  --repo-root <dir>           仓库根（默认由本脚本位置推导）
  --profile-template <file>   profile 模板（默认 profile-web-minimal.package.json）
  --npm-mirror <url>          npm registry（默认 https://registry.npmmirror.com）
  --npm-before <YYYY-MM-DD>   把内核**传递依赖**钉到该日期之前的版本
                              （默认 2026-09-22T16:00:00Z = rc.3 钉点；rc.1 用
                               2026-09-10T12:00:00Z。**按内核版本登记**，见脚本头说明）
                              传空串（--npm-before ""）表示不钉 —— 但那样可能装出
                              跑不起来的依赖树，见脚本头 NPM_BEFORE_DEFAULT 的说明
  --install-node              允许由本脚本安装 Node
  --node-version <ver>        要安装的 Node 版本（默认 22.19.0）
  --no-units                  不安装 systemd unit
  --release-root <dir>        🟡 **release 模式（P6a 阶段 A.2/A.3 草案）**：把内核装进
                              <dir>/<ver>/kernel（**复用** deploy/linux/kernel-release.sh install），
                              并把内核 unit 的 PATH 前置 <dir>/current/kernel/bin、
                              把 /etc/dsh-remote.env 的 DSH_RUNTIME_ROOT 指到 <dir>/runtime。
                              🔴 **绝不自动翻转 current**（首次迁移要人工确认）。
                              不传 = 现行为（原地覆盖式装 npm 全局包），逐字不变。
  -h, --help                  显示本帮助
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dsh-home)         DSH_HOME="$2"; shift 2 ;;
    --workspace-root)   WORKSPACE_ROOT="$2"; shift 2 ;;
    --user)             SERVICE_USER="$2"; shift 2 ;;
    --dsh-version)      DSH_VERSION="$2"; shift 2 ;;
    --repo-root)        REPO_ROOT="$(cd "$2" && pwd)"; shift 2 ;;
    --profile-template) PROFILE_TEMPLATE="$2"; shift 2 ;;
    --npm-mirror)       NPM_MIRROR="$2"; shift 2 ;;
    --npm-before)       NPM_BEFORE="$2"; shift 2 ;;
    --install-node)     INSTALL_NODE=1; shift ;;
    --node-version)     NODE_VERSION="$2"; shift 2 ;;
    --no-units)         INSTALL_UNITS=0; shift ;;
    --release-root)     RELEASE_ROOT="${2%/}"; shift 2 ;;
    -h|--help)          usage; exit 0 ;;
    *) die "未知参数：$1（用 --help 查看用法）" ;;
  esac
done

[[ $EUID -eq 0 ]] || die "请用 root 运行（sudo $0 ...）：需要建系统用户、写 /etc 与全局装内核。"

# 版本比较：ver_ge A B  → A >= B
ver_ge() { [[ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -n1)" == "$2" ]]; }

# ---- 工具解析：把 Windows 垫片挡在外面 ----
# WSL 会把 Windows 的 PATH 接进 Linux，同名工具可能解析到 /mnt/c/... 的 Windows 垫片：
# 在 Linux 上执行它会走 Windows 逻辑并诡异地失败（实测：corepack 垫片去联网下载 pnpm 然后超时）。
# 因此 /mnt/ 下的命中一律视为"没有"。真实云主机不存在该情况，属无害加固。
resolve_linux_tool() {
  local name="$1" p
  p="$(command -v "$name" 2>/dev/null || true)"
  [[ -z "$p" ]] && return 1
  case "$p" in
    /mnt/*)
      warn "$name 解析到 Windows 垫片（$p），按未安装处理"
      return 1 ;;
  esac
  printf '%s' "$p"
}

# ---- npm 网络加固 ----
# 长时间/重试：镜像站偶发抖动（实测出现过 ECONNRESET / 连接超时）
# IPv4 优先：部分镜像的 IPv6 链路质量明显更差
NPM_FLAGS=(--registry="$NPM_MIRROR" --fetch-timeout=900000 --fetch-retries=5
           --fetch-retry-mintimeout=20000 --fetch-retry-maxtimeout=180000)

npm_install_g() {
  env NODE_OPTIONS="${NODE_OPTIONS:-} --dns-result-order=ipv4first" \
    npm install -g "$@" "${NPM_FLAGS[@]}"
}

# ---------------------------------------------------------------- 1) Node

install_node_from_mirror() {
  local arch ver name tmp url
  command -v curl >/dev/null 2>&1 || die "需要 curl 才能下载 Node（apt-get install -y curl）"
  case "$(uname -m)" in
    x86_64|amd64)  arch=x64 ;;
    aarch64|arm64) arch=arm64 ;;
    *) die "不支持的 CPU 架构：$(uname -m)（请手动安装 Node >= $NODE_MIN）" ;;
  esac
  ver="v${NODE_VERSION}"
  name="node-${ver}-linux-${arch}"
  # 用 .tar.gz 而非 .tar.xz：少一个 xz-utils 依赖，最小化镜像也能解
  url="https://registry.npmmirror.com/-/binary/node/${ver}/${name}.tar.gz"
  tmp="$(mktemp -d)"

  log "下载 Node ${ver}（${arch}）：$url"
  if ! curl -fsSL --connect-timeout 20 -o "$tmp/node.tar.gz" "$url"; then
    rm -rf "$tmp"
    die "下载失败。请手动安装 Node >= $NODE_MIN 后重跑（或用 --node-version 换版本）。"
  fi
  tar -xzf "$tmp/node.tar.gz" -C "$tmp"
  [[ -x "$tmp/$name/bin/node" ]] || { rm -rf "$tmp"; die "解压结果不含 node 可执行文件，安装包可能损坏。"; }

  rm -rf "/usr/local/$name"
  mv "$tmp/$name" "/usr/local/"
  rm -rf "$tmp"
  for bin in node npm npx corepack; do
    [[ -e "/usr/local/$name/bin/$bin" ]] || continue
    ln -sfn "/usr/local/$name/bin/$bin" "/usr/local/bin/$bin"
  done
  hash -r
  log "已安装 $(/usr/local/bin/node -v)（/usr/local/$name，软链到 /usr/local/bin）"
}

check_node() {
  local nodeBin cur
  if ! nodeBin="$(resolve_linux_tool node)"; then
    if [[ $INSTALL_NODE -eq 1 ]]; then install_node_from_mirror; return; fi
    die "未找到 Linux 版 node。请先安装 Node >= $NODE_MIN（本机实测可用 https://registry.npmmirror.com/-/binary/node/ ），
     或加 --install-node --node-version $NODE_VERSION 让本脚本安装。"
  fi
  cur="$("$nodeBin" -v | sed 's/^v//')"
  if ! ver_ge "$cur" "$NODE_MIN"; then
    if [[ $INSTALL_NODE -eq 1 ]]; then install_node_from_mirror; return; fi
    die "Node 版本过低：$cur（需要 >= $NODE_MIN，zstd 解压 API 从 22.15 起提供）。
     请升级，或加 --install-node --node-version $NODE_VERSION。"
  fi
  log "Node $cur ✓（$nodeBin）"
}

# profile 模板是否"全为本地引用"（没有需要从 registry 下载的包）。
# 是的话 setup.mjs 会直接建 @local 链接、完全不调 pnpm，因此本机没必要装 pnpm。
# 判定逻辑与 server/scripts/setup.mjs 的 isLinkOnly 一致。
profile_template_is_link_only() {
  local tpl="$REPO_ROOT/server/data/templates/$PROFILE_TEMPLATE"
  [[ -f "$tpl" ]] || die "profile 模板不存在：$tpl"
  node -e '
    const fs = require("fs")
    const p = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))
    const deps = Object.values(p.dependencies || {})
    process.exit(deps.length === 0 || deps.every((s) => /^(link|file):/.test(String(s))) ? 0 : 1)
  ' "$tpl"
}

ensure_pnpm() {
  local pnpmBin want got
  want="$(pnpm_pinned_version)" || die "读不到 pnpm 钉版（真源 = package.json#packageManager）"
  if profile_template_is_link_only; then
    log "profile 依赖全为本地引用 → 不需要 pnpm（setup.mjs 会直接建 @local 链接）"
    return
  fi
  if pnpmBin="$(resolve_linux_tool pnpm)"; then
    got="$("$pnpmBin" -v 2>/dev/null || echo '?')"
    [[ "$got" == "$want" ]] \
      || die "已装 pnpm 版本 $got ≠ 钉版 $want（真源 = package.json#packageManager）⇒ **拒绝继续**。
     修法：npm i -g --prefix \$(npm prefix -g) pnpm@$want   （或改 package.json 的 packageManager）"
    log "pnpm $got ✓（$pnpmBin，真源 = package.json#packageManager）"
    return
  fi
  local spec="pnpm@$want"
  log "安装 pnpm（$spec，registry=$NPM_MIRROR）"
  npm_install_g "$spec"
  hash -r
  pnpmBin="$(resolve_linux_tool pnpm)" \
    || die "pnpm 安装后仍不可用（已装到 $NPM_GLOBAL_BIN，检查它是否在 PATH 中）。"
  got="$("$pnpmBin" -v 2>/dev/null || echo '?')"
  [[ "$got" == "$want" ]] || die "刚装的 pnpm 版本 $got ≠ 钉版 $want"
  log "pnpm $got ✓（$pnpmBin）"
}

# 把 npm 全局 bin 目录提到 PATH 最前。
# 必要性：npm 的全局前缀未必是 /usr/local（本机 WSL 里 Node 用版本化前缀安装，
# 全局 bin 落在 …/node-v22.19.0-linux-x64/bin，不在默认 PATH 上），
# 结果 `npm i -g` 装的 dsh / pnpm 都"装了但找不到"。
ensure_global_bin() {
  NPM_GLOBAL_BIN="$(npm prefix -g)/bin"
  [[ -d "$NPM_GLOBAL_BIN" ]] || die "npm 全局 bin 目录不存在：$NPM_GLOBAL_BIN（npm prefix -g 输出异常）"
  export PATH="$NPM_GLOBAL_BIN:$PATH"
  hash -r
  log "npm 全局 bin：$NPM_GLOBAL_BIN"
}

# ---------------------------------------------------------------- 2) 服务用户与目录

ensure_user() {
  if id -u "$SERVICE_USER" >/dev/null 2>&1; then
    log "服务用户 $SERVICE_USER 已存在 ✓"
  else
    useradd --system --create-home --shell /bin/bash "$SERVICE_USER"
    log "已创建系统用户 $SERVICE_USER（home=/home/$SERVICE_USER）"
  fi
}

ensure_dirs() {
  local dirs=(
    "$DSH_HOME"
    "$DSH_HOME/profiles/web"
    "$DSH_HOME/logs"
    "$WORKSPACE_ROOT"
    # 与 dsh-bundle-patch.yml 的根表一一对应，避免插件首次读写时因目录缺失报错
    "$WORKSPACE_ROOT/写作训练"
    "$WORKSPACE_ROOT/写作训练/邮件附件"
    "$WORKSPACE_ROOT/全局数据"
    "$WORKSPACE_ROOT/记忆归档"
    "$WORKSPACE_ROOT/DSH工具"
    "$WORKSPACE_ROOT/插件开发体系模板"
  )
  mkdir -p "${dirs[@]}"
  chown -R "$SERVICE_USER:$SERVICE_USER" "$DSH_HOME" "$WORKSPACE_ROOT"
  log "目录就绪：$DSH_HOME、$WORKSPACE_ROOT（含 6 个插件根）"
}

# ---------------------------------------------------------------- 3) 内核（release 模式）

# 🟡 release 模式（P6a 阶段 A.2 草案，2026-09-26）：把内核装进**版本化目录**，**绝不自动翻 current**。
# 🔴 实现上刻意**复用** `deploy/linux/kernel-release.sh install`，而**不是**在这里重写一遍
#    "装包 + 版本校验 + 依赖树形状自检 + 自研插件快照 + profile 两键/lockfile + release.json + 权限"。
#    理由：那套逻辑已在 A.1 落地；抄第二遍必然漂移（P6a §⑦-7 说的"多处依赖 npm root -g"正是这种成本）。
ensure_kernel_release() {
  local kr="$REPO_ROOT/deploy/linux/kernel-release.sh"
  [[ -f "$kr" ]] || die "release 模式需要 $kr（P6a 阶段 A.1）"
  log "release 模式：把 @deepseek-ai/dsh@$DSH_VERSION 装进 $RELEASE_ROOT/$DSH_VERSION/（复用 kernel-release.sh install）"
  bash "$kr" install "$DSH_VERSION" --npm-before "$NPM_BEFORE" --profile-template "$PROFILE_TEMPLATE" \
    || die "kernel-release.sh install 失败（详见其输出）"

  [[ -x "$RELEASE_ROOT/$DSH_VERSION/kernel/bin/dsh" ]] \
    || die "装完后找不到可执行入口：$RELEASE_ROOT/$DSH_VERSION/kernel/bin/dsh"
  log "该版本的内核入口：$RELEASE_ROOT/$DSH_VERSION/kernel/bin/dsh ✓"

  # 稳定软链 runtime 由 kernel-release.sh install 建好（相对链 ⇒ 跟着 current 走）。
  # ⚠️ 首次迁移时 current 可能还不存在 ⇒ runtime 是**断链** ⇒ 本脚本随后要跑的 setup_profile()
  #    会拿 DSH_RUNTIME_ROOT 去找 @deepseek-ai/dsh-tools ⇒ 必须给它一个**当下真实存在**的根。
  local runtime_link="$RELEASE_ROOT/runtime"
  if [[ -L "$RELEASE_ROOT/current" ]]; then
    RUNTIME_ROOT="$runtime_link"
    log "current → $(readlink "$RELEASE_ROOT/current") ✓（DSH_RUNTIME_ROOT ⇒ $RUNTIME_ROOT）"
  else
    # 顶替路径 = kernel-release.sh 的 RUNTIME_REL，语义与 runtime 最终指向的是**同一个目录**。
    RUNTIME_ROOT="$RELEASE_ROOT/$DSH_VERSION/kernel/lib/node_modules/@deepseek-ai/dsh/node_modules"
    warn "🔴 $RELEASE_ROOT/current **不存在**（因此 runtime 是断链）：本次 setup_profile() 将改用"
    warn "   $RUNTIME_ROOT 顶替；/etc/dsh-remote.env 稍后**仍会**被指向稳定的 $runtime_link。"
    warn "   首次迁移（A.4）请**先人工确认**再翻链：bash $kr switch $DSH_VERSION"
  fi
  # ⚠️ 本函数**不**建 current、**不**翻它、**不**重启内核 —— 这三件事都归 kernel-release.sh，人工触发。
  #    （这一步"不许自动"是 P6a A.2 的明文要求。）
}

# ---------------------------------------------------------------- 3) 内核（默认：原地覆盖式装 npm 全局包）

ensure_kernel() {
  # 🟡 release 模式直接分流：**默认（RELEASE_ROOT 为空）走下面的原逻辑，逐字不变**。
  if [[ -n "$RELEASE_ROOT" ]]; then
    ensure_kernel_release
    return
  fi
  local root pkg installed
  root="$(npm root -g)"
  pkg="$root/@deepseek-ai/dsh/package.json"
  if [[ -f "$pkg" ]]; then
    installed="$(node -e 'const fs=require("fs");process.stdout.write(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).version)' "$pkg")"
  else
    installed=""
  fi

  if [[ "$installed" == "$DSH_VERSION" ]]; then
    log "内核 @deepseek-ai/dsh@$installed 已就位 ✓"
  else
    [[ -n "$installed" ]] && warn "已装内核 $installed ≠ 目标 $DSH_VERSION，将重装"
    # --before 只给**内核**加，不给 pnpm：它的作用是钉住内核的传递依赖解析。
    # 这里刻意用不加引号的字符串做单词拆分（日期里不会有空格/通配符），
    # 为的是能在"不钉"时安全地传空 —— 用数组在空数组 + set -u 下会报 unbound。
    local beforeFlag=""
    if [[ -n "$NPM_BEFORE" ]]; then
      beforeFlag="--before=$NPM_BEFORE"
      log "传递依赖钉到 $NPM_BEFORE 之前（避免上游发版漂移改变依赖树形状）"
    else
      warn "**未钉传递依赖**（--npm-before 为空）：上游一发版就可能装出跑不起来的依赖树"
    fi
    local attempt
    for attempt in 1 2 3; do
      log "安装内核 @deepseek-ai/dsh@$DSH_VERSION（第 $attempt 次，registry=$NPM_MIRROR）"
      # shellcheck disable=SC2086  # 有意做单词拆分，见上面 beforeFlag 的说明
      if npm_install_g "@deepseek-ai/dsh@$DSH_VERSION" $beforeFlag; then break; fi
      if [[ $attempt -eq 3 ]]; then
        die "内核安装连续 3 次失败，多为网络问题（镜像站抖动）。
     可换镜像重跑，例如：--npm-mirror https://mirrors.huaweicloud.com/repository/npm/"
      fi
      warn "第 $attempt 次失败，5 秒后重试"
      sleep 5
    done
    installed="$(node -e 'const fs=require("fs");process.stdout.write(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).version)' "$pkg")"
    [[ "$installed" == "$DSH_VERSION" ]] || die "内核版本校验失败：期望 $DSH_VERSION，实际 $installed"
    log "内核 @deepseek-ai/dsh@$installed ✓"
  fi

  # ---- 依赖树形状自检（2026-09-23 那次"全绿却跑不起来"事故的直接防线）----
  #
  # 内核的插件加载器要求依赖树是**顶层扁平**的：同一个包若被 npm 嵌进
  # `<pkg>/node_modules/@deepseek-ai/` 里，内核启动后会报
  #   plugin(s) failed to load: @deepseek-ai/dsh-sandbox-local; could not be resolved
  # 然后 crash-loop；而**探针在它崩溃前那几秒采样会报全绿**（真实事故就这样溜过验收）。
  #
  # 判据取自实测：树坏了的时候，`dsh-base/node_modules/@deepseek-ai/` 是非空的；
  # 树好的时候它是空的。这里直接判它 —— 比"试着启动再等 15 秒"轻，且能在装配阶段就拦住。
  local nestedScope="$root/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-base/node_modules/@deepseek-ai"
  local nestedCount=0
  if [[ -d "$nestedScope" ]]; then
    nestedCount="$(find "$nestedScope" -mindepth 1 -maxdepth 1 | wc -l)"
  fi
  if (( nestedCount > 0 )); then
    die "依赖树形状不对：dsh-base 下有 $nestedCount 个嵌套的 @deepseek-ai 包（应为顶层扁平）。
     这种树**内核启动后会 crash-loop**，且探针会误报全绿。
     修法：用已知可用的日期重装依赖解析，例如
       sudo bash $0 --npm-before 2026-09-22T16:00:00Z $( [[ $INSTALL_NODE -eq 1 ]] && echo --install-node )
     或换一个你确认可用的 --npm-before 日期（见脚本头 NPM_BEFORE_DEFAULT 的说明）。"
  fi
  log "依赖树形状自检通过（顶层扁平）✓"

  # dsh-tools 是插件运行时唯一的裸导入，但落点随安装方式不同：
  #   - 便携版        ：<root>/@deepseek-ai/dsh-tools（顶层）
  #   - npm 全局安装  ：<root>/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-tools
  #     （它不是 dsh 的直接依赖，是被传递依赖带进来的，npm 不会扁平化到顶层）
  # 逻辑与 server/scripts/setup.mjs 的 findToolsRoot 保持一致。
  local npmRoot nested
  npmRoot="$(npm root -g)"
  nested="$npmRoot/@deepseek-ai/dsh/node_modules"
  if [[ -f "$npmRoot/@deepseek-ai/dsh-tools/package.json" ]]; then
    RUNTIME_ROOT="$npmRoot"
  elif [[ -f "$nested/@deepseek-ai/dsh-tools/package.json" ]]; then
    RUNTIME_ROOT="$nested"
  else
    die "找不到 @deepseek-ai/dsh-tools（插件运行时的唯一裸导入），已找过：
       $npmRoot/@deepseek-ai/dsh-tools
       $nested/@deepseek-ai/dsh-tools
     没有它，adapter / memory-system 加载即失败。请确认内核安装完整后重试。"
  fi

  local dshBin
  dshBin="$(resolve_linux_tool dsh)" || die \
    "dsh 命令不可用（内核已装到 $NPM_GLOBAL_BIN，但它不在 PATH 中或解析到了 Windows 垫片）。"
  log "内核运行时根：$RUNTIME_ROOT ✓"
  log "dsh 命令：$dshBin ✓"
}

# ---------------------------------------------------------------- 4) profile + 最小插件集

# 服务用户必须能"穿过"仓库路径的每一级父目录，并读到 plugins 源码。
# 为什么必须查：profile 里的 @local/* 是指向仓库的符号链接，内核按 realpath 解析；
# 服务用户读不到时内核只报 `cannot resolve profile bundle "@local/dsh-adapter"`，
# 完全不会提示权限问题，非常容易误判成"依赖没装"。
# 典型坑（实测踩到）：仓库 clone 在 /root 下——/root 是 0700，
# 这时 `chmod -R a+rX <仓库>` 也救不回来，必须放开祖先目录或换位置。
ensure_repo_readable() {
  if ! command -v runuser >/dev/null 2>&1; then
    warn "无 runuser，跳过仓库可读性检查"
    return
  fi
  runuser -u "$SERVICE_USER" -- test -r "$REPO_ROOT/server/scripts/setup.mjs" 2>/dev/null && return

  # 自下而上找"第一级穿不过去"的目录（越靠上越是根因）
  local p="$REPO_ROOT" blocked=""
  while [[ "$p" != "/" ]]; do
    runuser -u "$SERVICE_USER" -- test -x "$p" 2>/dev/null || blocked="$p"
    p="$(dirname "$p")"
  done

  if [[ -n "$blocked" ]]; then
    die "服务用户 $SERVICE_USER 穿不过目录 $blocked（对 others 无 x 权限），因此读不到仓库：
       $REPO_ROOT
     profile 里的 @local/* 是指向仓库的符号链接，服务用户读不到时内核只会报
     \"cannot resolve profile bundle\"，不会提示权限问题。

     推荐修法（把仓库放到公共位置，然后重跑本次命令）：
       sudo mv \"$REPO_ROOT\" /opt/dsh-remote
       sudo bash /opt/dsh-remote/deploy/linux/setup.sh --repo-root /opt/dsh-remote
     若坚持留在原处，只能放开该目录的穿越位（会降低它的隔离性，自行权衡）：
       sudo chmod o+x \"$blocked\""
  fi

  warn "服务用户 $SERVICE_USER 读不到仓库内的文件，补读/执行权限（a+rX，不改变属主）"
  chmod -R a+rX "$REPO_ROOT"
  runuser -u "$SERVICE_USER" -- test -r "$REPO_ROOT/server/scripts/setup.mjs" 2>/dev/null \
    || die "补权限后仍读不到 $REPO_ROOT，请检查其祖先目录权限。"
}

setup_profile() {
  log "装配 profile 与插件（模板 $PROFILE_TEMPLATE）"
  # PNPM_BIN 显式传入：setup.mjs 走 PATH 找 pnpm，在 WSL 里可能命中 Windows 垫片
  local pnpmBin=""
  pnpmBin="$(resolve_linux_tool pnpm || true)"
  # 🔴 release 模式：把插件源目录显式指到 release 的 current/plugins（H5 / R2）。
  #    不注入 ⇒ setup.mjs 会按 REPO_ROOT/plugins 生成 `link:…/opt/dsh-remote/plugins/<x>`
  #    ⇒ pnpm install 每次把它重建回 /opt ⇒ @local/dsh-adapter 又指向 staging（约束 1 被破坏）。
  local pluginsEnv=()
  if [[ -n "$RELEASE_ROOT" ]]; then
    pluginsEnv=("DSH_PLUGINS_DIR=$RELEASE_ROOT/current/plugins")
    log "插件源目录 → $RELEASE_ROOT/current/plugins（DSH_PLUGINS_DIR）"
  fi
  env \
    DSH_HOME="$DSH_HOME" \
    DSH_WORKSPACE_ROOT="$WORKSPACE_ROOT" \
    DSH_RUNTIME_ROOT="$RUNTIME_ROOT" \
    DSH_ADAPTER_LOG="$DSH_HOME/dsh-adapter-apply.log" \
    PNPM_BIN="$pnpmBin" \
    "${pluginsEnv[@]+"${pluginsEnv[@]}"}" \
    node "$REPO_ROOT/server/scripts/setup.mjs" \
      --dsh-home "$DSH_HOME" \
      --profile-template "$PROFILE_TEMPLATE"

  chown -R "$SERVICE_USER:$SERVICE_USER" "$DSH_HOME"
  log "profile 装配完成"

  # 校验：bundles 必须只在最小集里，避免误把全量插件带上去
  local pkg="$DSH_HOME/profiles/web/package.json"
  node -e '
    const fs = require("fs")
    const p = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))
    const bundles = (p.dsh && p.dsh.profile && p.dsh.profile.bundles) || []
    console.log("[setup] profile bundles: " + bundles.join(", "))
    const local = bundles.filter((b) => b.startsWith("@local/"))
    const unexpected = local.filter((b) => !["@local/dsh-adapter", "@local/memory-system"].includes(b))
    if (unexpected.length) {
      console.error("[setup] 非预期插件进入 bundles: " + unexpected.join(", "))
      process.exit(1)
    }
  ' "$pkg"
}

# 把仓库里全部自研插件链接进 profile 的 node_modules/@local/。
# 白名单条目的 path 是包名，必须能从 profile 解析到；不链接就会在开机后台静默报 INVALID_PATH。
# 幂等：先 rm 再 ln。
# 属主必须交回服务用户：profiles/web/node_modules 归 dsh 所有，以其他身份往里写会
# Permission denied（本项目踩过，且 systemd 下会表现为服务起不来）。
#
# 🔴 约束 1（release 所有权迁移设计 §2.1）：release 模式下 `@local/*` 必须与
#    `<release>/current/plugins/*` **严格一一对应**。理由：release 对服务用户**只读**，
#    而内核 boot 的 heal 会"少一条就新建、多一条就 unlink" —— 两边不逐条对齐就必然
#    EACCES ⇒ boot 崩。⇒ 本函数**必须双向对齐**：既按目录生成，也**删掉 release 里
#    已不存在的陈旧链接**（只增不删 = 违反约束 1）。
#    生成与删除**都遍历目录**，绝不写死插件名清单（写死会在下次加/删插件时再次错位）。
#    （H6：连跑两次，第 2 次必须零变化 —— 由这两段"先算期望集再比对"的写法保证。）
link_local_plugins() {
  # 🟡 release 模式：`@local/*` 指向 **release 的 current/plugins**
  #    ⇒ 之后切包**只翻 current 一个链接**，自研插件同时生效/回退（原子）。
  #    默认模式仍指向仓库 plugins/（原地覆盖式），逐字不变。
  local src_root
  if [[ -n "$RELEASE_ROOT" ]]; then
    src_root="$RELEASE_ROOT/current/plugins"
    [[ -d "$src_root" ]] || die "release 模式下 $src_root 不存在（current 还没建？请先人工跑一次 kernel-release.sh switch）"
  else
    src_root="$REPO_ROOT/plugins"
  fi
  local dir="$DSH_HOME/profiles/web/node_modules/@local"
  install -d -m 0755 -o "$SERVICE_USER" -g "$SERVICE_USER" "$dir"
  local n=0 p name
  for p in "$src_root"/*/; do
    name="$(basename "$p")"
    [[ "$name" == "node_modules" ]] && continue
    [[ -f "${p}package.json" ]] || continue
    rm -f "$dir/$name"
    ln -s "${p%/}" "$dir/$name"
    chown -h "$SERVICE_USER:$SERVICE_USER" "$dir/$name"
    n=$((n + 1))
  done
  log "已链接 $n 个自研插件到 $dir"

  # ---- 反向对齐：删掉 release 里已不存在的陈旧 @local/<x>（约束 1；多一条 ⇒ heal 想 unlink ⇒ EACCES 崩）----
  # ⚠️ 本段只在 **release 模式**生效：默认模式（src_root = 仓库 plugins/）下"仓库就是真相"，
  #    删掉的东西下次 rsync 也会带回来，行为与旧版逐字一致，不改。
  if [[ -n "$RELEASE_ROOT" ]]; then
    local l ln stale=0
    for l in "$dir"/*; do
      [[ -e "$l" || -L "$l" ]] || continue          # 空目录（无任何 @local 条目）时跳过字面量的 '*'
      ln="$(basename "$l")"
      [[ -d "$src_root/$ln" ]] && continue          # release 里有 ⇒ 保留
      warn "删除陈旧链接：@local/$ln（$src_root 里已不存在）—— 多一条会让 heal 做 unlink ⇒ release 只读 ⇒ EACCES ⇒ boot 崩"
      rm -f "$l"
      stale=$((stale + 1))
    done
    if (( stale > 0 )); then
      log "已删除 $stale 条陈旧 @local 链接（与 $src_root 逐条对齐）"
    else
      log "@local 链接与 $src_root 逐条对齐（无需删除）✓"
    fi
  fi
}

# 落 adapter 白名单种子：**仅在目标不存在时**写入。
# 已存在就必须原样保留 —— 运行期会有增删（enable/disable/add），覆盖等于把用户状态冲掉。
install_hotplug_seed() {
  local seed="${1:-$REPO_ROOT/server/data/templates/hotplug-manifest.seed.yml}"
  local dest="${2:-$DSH_HOME/hotplug-manifest.yml}"
  if [[ ! -f "$seed" ]]; then
    warn "白名单种子不存在，跳过：$seed"
    return 0
  fi
  if [[ -f "$dest" ]]; then
    # 已有**条目**就保留（运行期会增删，冲掉等于丢用户状态）。
    # 但"文件在、里面 0 条条目"必须补装 —— 实测踩到的坑：
    # 首次装配前若因任何原因留下过一个空白名单（哪怕只是被 touch 出来的），
    # 种子就永远落不下来，而日志只说"保留不动"，看起来一切正常，实际一个插件都没挂。
    local n
    n="$(grep -c '^[[:space:]]*- id:' "$dest" 2>/dev/null || true)"
    if [[ "${n:-0}" -gt 0 ]]; then
      log "白名单已有 $n 条条目，保留不动：$dest"
      return 0
    fi
    log "白名单存在但 0 条条目，补装种子：$dest"
  fi
  install -m 0644 -o "$SERVICE_USER" -g "$SERVICE_USER" "$seed" "$dest"
  log "已落白名单种子：$dest"
}

# 白名单自检：每条 path 必须能从 profile 解析到（契约 = 包名）。
# 反面教材：条目不解析时 adapter 会在**开机后台**静默失败（真机实测：INVALID_PATH，
# 而当时的探针全绿），所以必须在这里就地拦住。
hotplug_selfcheck() {
  local script="$REPO_ROOT/server/scripts/check-hotplug-paths.mjs"
  if [[ ! -f "$script" ]]; then
    warn "白名单自检脚本缺失，跳过：$script"
    return 0
  fi
  node "$script" "$DSH_HOME" \
    || die "白名单 path 自检未通过，已中止（契约：path 必须是可从 profile 解析的包名）"
}

# 归一化 DSH_HOME 里配置文件的权限：
#  1) .credentials.yaml 必须属主专属可读——内核在 Linux 上强制检查，不满足直接拒绝启动：
#       credentials-local: <path> is readable beyond its owner (mode 777);
#       run "chmod 600 <path>" before starting again
#     且必须显式收紧：模板是从仓库拷来的，而仓库权限还被 ensure_repo_readable 放宽到 a+rX，
#     于是拷出来就是 0777 → 内核启动即失败（错误埋在插件树深处，很难定位）。
#  2) settings.yaml / .agent-presets 同理带上 0777：数据目录里的配置不该对所有人可写。
#     （/mnt 等 NTFS 挂载会把文件报告为 777，copyFileSync 会原样保留这个权限位。）
fix_config_modes() {
  local cred="$DSH_HOME/.credentials.yaml" mode
  if [[ -f "$cred" ]]; then
    mode="$(stat -c '%a' "$cred")"
    if [[ "$mode" != "600" && "$mode" != "400" ]]; then
      chmod 600 "$cred"
      log "已收紧凭据权限：$cred（$mode → 600）"
    fi
  fi
  if [[ -f "$DSH_HOME/settings.yaml" ]]; then chmod 644 "$DSH_HOME/settings.yaml"; fi
  if [[ -d "$DSH_HOME/.agent-presets" ]]; then chmod -R go-w "$DSH_HOME/.agent-presets"; fi
}

# ---------------------------------------------------------------- 5) 环境变量文件

write_env_file() {
  local f=/etc/dsh-remote.env
  if [[ -f "$f" ]]; then
    log "$f 已存在，不覆盖（如需重写请先手动删除）"
    return
  fi
  cat > "$f" <<EOF
# dsh-remote 运行时环境（systemd 两个 unit 共用；由 deploy/linux/setup.sh 生成）
# 改完执行：systemctl daemon-reload && systemctl restart dsh-kernel dsh-remote

# ---- 路径类（本脚本已按机器实际情况填好）----
DSH_HOME=$DSH_HOME
DSH_WORKSPACE_ROOT=$WORKSPACE_ROOT
DSH_RUNTIME_ROOT=$RUNTIME_ROOT
DSH_ADAPTER_LOG=$DSH_HOME/dsh-adapter-apply.log

# ---- 网关：对外接入（按需打开，改完重启 dsh-remote）----
# 内核端口固定 3080，与 dsh-kernel.service 一致，不要改
# DSH_GATEWAY_UPSTREAM=http://127.0.0.1:3080
# 对外直连必须换 host（默认只绑回环）
# DSH_GATEWAY_HOST=0.0.0.0
# DSH_GATEWAY_HTTPS_PORT=28443
# 固定 IP 直连时必填，否则证书 CN/SAN 不匹配
# DSH_GATEWAY_TLS=1
# DSH_GATEWAY_TLS_SAN=<你的公网IP>
# 客户端证书白名单（替代 IP 锁，适配家庭/出差）：先 init 再签发设备证书
# DSH_GATEWAY_MTLS=1
# 客户端静态资源目录（客户端已拆分为独立仓库：tools/fetch-client.ps1 拉取后指到这里）
# DSH_GATEWAY_WEB_DIR=$REPO_ROOT/client/web
EOF
  chmod 0644 "$f"
  log "已生成 $f（网关项默认注释，按需放开）"
}

# 🟡 A.3：release 模式把 /etc/dsh-remote.env 的 DSH_RUNTIME_ROOT 指到稳定软链 <release>/runtime。
# 为什么不能只靠 write_env_file()：它"文件已存在就不覆盖"（幂等保护）⇒ 老机器上这个键会一直是旧值。
# 为什么要先备份：这是 /etc 下的运行时配置，改错会同时影响两个 unit。
point_env_at_release() {
  local f=/etc/dsh-remote.env want="$RELEASE_ROOT/runtime" cur bak
  [[ -f "$f" ]] || die "$f 不存在（先让本脚本生成它，再开 --release-root）"
  cur="$(grep -E '^DSH_RUNTIME_ROOT=' "$f" | tail -1 | cut -d= -f2- || true)"
  if [[ "$cur" == "$want" ]]; then
    log "DSH_RUNTIME_ROOT 已指向 $want ✓"
    return 0
  fi
  bak="$f.bak-release-$(date +%Y%m%d-%H%M%S)"
  cp -a "$f" "$bak"
  if grep -qE '^DSH_RUNTIME_ROOT=' "$f"; then
    sed -i "s|^DSH_RUNTIME_ROOT=.*|DSH_RUNTIME_ROOT=$want|" "$f"
  else
    printf 'DSH_RUNTIME_ROOT=%s\n' "$want" >> "$f"
  fi
  log "已把 DSH_RUNTIME_ROOT 改为 $want（原文备份：$bak）"
  log "   ⚠️ 生效需：systemctl daemon-reload && systemctl restart dsh-kernel（本脚本**不**重启服务）"
}

# ---------------------------------------------------------------- 6) systemd unit

install_units() {
  local dir=/etc/systemd/system
  for unit in dsh-kernel.service dsh-remote.service; do
    local src="$REPO_ROOT/deploy/linux/$unit"
    [[ -f "$src" ]] || die "缺少 unit 模板：$src"
    # 🟡 A.3：release 模式下，**内核 unit** 的 PATH 要**前置** <release>/current/kernel/bin
    #    （保留全局 bin 作兜底：current 未建成/坏掉时，至少 node 还找得到）。
    #    ⚠️ 只改 PATH 这一处；`ExecStart` 与 `WorkingDirectory` **保持原样**（P6a A.3 明文要求）。
    #    网关 unit 不前置它 —— 网关要的是 node，不是内核 bin。
    local kernel_bin="$NPM_GLOBAL_BIN"
    if [[ -n "$RELEASE_ROOT" && "$unit" == "dsh-kernel.service" ]]; then
      kernel_bin="$RELEASE_ROOT/current/kernel/bin:$NPM_GLOBAL_BIN"
    fi
    sed -e "s|__SERVICE_USER__|$SERVICE_USER|g" \
        -e "s|__REPO_ROOT__|$REPO_ROOT|g" \
        -e "s|__DSH_HOME__|$DSH_HOME|g" \
        -e "s|__NPM_GLOBAL_BIN__|$kernel_bin|g" \
        "$src" > "$dir/$unit"
    chmod 0644 "$dir/$unit"
    log "已写入 $dir/$unit"
  done
  systemctl daemon-reload
  log "已 daemon-reload"
}

# ---------------------------------------------------------------- 6) journald 上限

# journald 默认 SystemMaxUse = 文件系统的 10%（封顶 4 GiB）⇒ 40 GB 盘上就是 4 GB。
# 而实测 journal 的盘占用**主要来自文件预分配**：journald 每建一个新文件先分配 8 MiB
# 且不随内容缩小（2026-09-23 WSL 实测：101 个文件全为 8 MiB = 808 MB，
# 而真实日志内容只有 945 KB / 6375 行）。所以这里同时收"总量"与"单文件"上限。
# 用 drop-in 覆盖，**不动发行版自带的 /etc/systemd/journald.conf 本体**。
install_journald_limits() {
  local src="$REPO_ROOT/deploy/linux/journald-dsh.conf"
  local dir=/etc/systemd/journald.conf.d
  local dst="$dir/50-dsh.conf"

  if [[ ! -f "$src" ]]; then
    warn "缺少 $src，跳过 journald 上限（journal 将走默认：盘的 10%，40 GB 盘上约 4 GB）"
    return 0
  fi

  mkdir -p "$dir"
  if [[ -f "$dst" ]] && cmp -s "$src" "$dst"; then
    log "journald 上限已就位 ✓（$dst）"
    return 0
  fi

  # 用 install 而非 cp：显式控制权限位（权威配置不该对所有人可写）
  install -m 0644 "$src" "$dst"
  log "已写入 $dst（SystemMaxUse=500M / SystemMaxFileSize=50M）"
  NEED_JOURNALD_RESTART=1
}

# ---------------------------------------------------------------- 0) 前置体检

# Web 客户端是否就位。
# `client/` 在 .gitignore 里（客户端已拆到独立仓库 skyblade47/dsh-remote-client），
# **git 克隆不会带它** —— 必须在本机先跑 tools/fetch-client.ps1 再上传。
# 缺了它：内核与网关都照常起来、check-ready 的其余项也全 PASS，但浏览器打开是 404。
# 属于"一路绿灯直到最后一步才发现"的坑，所以在这里提前喊，不等到最后。
MISSING_WEB_CLIENT=0
REPO_HAS_STRAY=""
preflight_web_client() {
  local web="${DSH_GATEWAY_WEB_DIR:-$REPO_ROOT/client/web}"
  if [[ -f "$web/index.html" ]]; then
    log "Web 客户端就位 ✓（$web/index.html）"
    return 0
  fi
  MISSING_WEB_CLIENT=1
  warn "**找不到 Web 客户端**：$web/index.html"
  warn "  ⇒ 服务会正常起来，但浏览器打开只会 404。"
  warn "  ⇒ 在**本机**仓库根执行：tools/fetch-client.ps1（克隆不会带 client/，它在 .gitignore 里）"
  warn "     然后重新上传；或把 /etc/dsh-remote.env 的 DSH_GATEWAY_WEB_DIR 指到已有客户端目录。"
}

# 仓库是否"人人可写"。
# 为什么单列一项：手册让你用 root 跑本脚本（`sudo bash …/setup.sh`、`sudo bash …/restart-kernel.sh`），
# 而 §4.4 又建了 ops 用户。仓库若对 others 可写，**任何本地用户都能改写将以 root 执行的脚本**。
# 实测（2026-09-23）：从 Windows(DrvFs) 直接 rsync 上传后，仓库里有 526 个 others-可写条目，
# 四个 deploy/linux/*.sh 全是 -rwxrwxrwx —— 所以这不是假想问题。
REPO_WORLD_WRITABLE=0
preflight_repo_writable() {
  local n
  n="$(find "$REPO_ROOT" -path '*/node_modules' -prune -o -perm -o+w -print 2>/dev/null | wc -l)"
  if (( n == 0 )); then
    log "仓库权限检查通过（无 others-可写条目）✓"
    return 0
  fi
  REPO_WORLD_WRITABLE="$n"
  warn "**仓库里有 $n 个 others-可写条目**（含本脚本自己）"
  warn "  ⇒ 本脚本要以 root 运行，而任何本地用户都能改写它 ⇒ 本地提权面。"
  warn "  修法（立刻）：sudo chmod -R go-w $REPO_ROOT"
  warn "  根治（上传时）：rsync 加 --chmod=D755,F644 —— 见部署手册 §7.2"
}

# 仓库里是否混着"不该上传"的目录。
# 这些目录被 .gitignore 忽略，但 **rsync 不读 gitignore** ⇒ 会一起传到服务器。
# 其中 dsh-data 是开发态默认数据目录：本地跑过 dev 后里面有会话与凭据，传上去就是把本机数据泄露到服务器。
preflight_repo_stray() {
  local found="" d
  for d in dsh-data srv 'E:' .trae; do
    [[ -e "$REPO_ROOT/$d" ]] && found="$found $d"
  done
  if [[ -z "$found" ]]; then
    log "仓库内容检查通过（无 dsh-data / srv / E: / .trae 等不该上传的目录）✓"
    return 0
  fi
  REPO_HAS_STRAY="$found"
  warn "仓库里有**不该上传**的目录：$found"
  warn "  ⇒ 上传时没排除掉（rsync 不读 .gitignore）。其中 dsh-data 若装过开发态数据，"
  warn "     里面会有会话与凭据 —— 等于把本机数据带到了服务器。"
  warn "  修法：删掉它们，并按手册 §7.2 的排除项重新上传。"
}

# 供测试加载函数用：SETUP_LIB_ONLY=1 时只定义函数、不执行任何副作用。
# 位置要求：必须在**全部函数定义之后**、**第一条副作用语句之前**。
if [[ "${SETUP_LIB_ONLY:-0}" == "1" ]]; then
  # 被 source 时 return；被直接执行时 exit（两种调用方式都不报错）
  return 0 2>/dev/null || exit 0
fi

# ---------------------------------------------------------------- main

log "仓库根：$REPO_ROOT"
[[ -f "$REPO_ROOT/server/scripts/setup.mjs" ]] || die "仓库根判定有误（找不到 server/scripts/setup.mjs）：$REPO_ROOT，请用 --repo-root 指定。"

preflight_web_client
preflight_repo_writable
preflight_repo_stray

check_node
ensure_global_bin

# 🔴 pnpm 钉版：**唯一真源** = package.json#packageManager（读取入口见 deploy/linux/lib/）
source "$REPO_ROOT/deploy/linux/lib/pnpm-version.sh"
PNPM_VERSION="$(pnpm_pinned_version)" || die "读不到 pnpm 钉版（真源 = package.json#packageManager）"
log "pnpm 钉版 = $PNPM_VERSION（真源 = package.json#packageManager）"

ensure_pnpm
ensure_user
ensure_dirs
ensure_kernel
ensure_repo_readable
setup_profile
link_local_plugins
install_hotplug_seed
hotplug_selfcheck
fix_config_modes
write_env_file
if [[ -n "$RELEASE_ROOT" ]]; then point_env_at_release; fi
install_journald_limits
if [[ $INSTALL_UNITS -eq 1 ]]; then install_units; fi

cat <<EOF

$(printf '=%.0s' {1..64})
落地完成。接下来（按顺序）：

  1. 先手动验证，不要直接开公网：
       sudo -u $SERVICE_USER env DSH_HOME=$DSH_HOME \\
         $(command -v dsh) web --port 3080 --no-open
     终端会打印带 token 的地址（http://127.0.0.1:3080/?token=...），用 SSH 隧道在本地打开它；
     直接访问不带 token 的根路径会得到 401（内核自身的鉴权，属预期）。
     确认界面能打开、能新建会话后，Ctrl-C 退出再走第 3 步。

  2. 按需编辑 /etc/dsh-remote.env 放开网关项（TLS / 固定 IP / mTLS）。

  3. 启用并启动：
       sudo systemctl enable --now dsh-kernel dsh-remote
       sudo systemctl status dsh-kernel dsh-remote
       sudo journalctl -u dsh-remote -f

  4. 客户端证书白名单（启用 DSH_GATEWAY_MTLS 后必须先做）：
       sudo -u $SERVICE_USER env DSH_HOME=$DSH_HOME DSH_GATEWAY_DATA_DIR=$DSH_HOME \\
         node $REPO_ROOT/server/scripts/client-cert.mjs init --data-dir $DSH_HOME
       # 签发设备证书：... client-cert.mjs issue <设备名>

  5. 安全组/防火墙：只放行你的来源 IP → 网关 HTTPS 端口；3080 绝不对外（内核零入站鉴权）。

  Windows 主机请改用 server/scripts/install-service.ps1（NSSM）。
$(printf '=%.0s' {1..64})
EOF

if [[ "${NEED_JOURNALD_RESTART:-0}" == "1" ]]; then
  warn "journald 上限**刚写入但尚未生效**。生效方式：sudo systemctl restart systemd-journald"
  warn "（存量很大时顺手回收一次：sudo journalctl --vacuum-size=500M）"
fi

# 放在最后再说一遍：这是"前面全绿、最后一步才翻车"的那类问题，要多喊一次。
if [[ "${MISSING_WEB_CLIENT:-0}" == "1" ]]; then
  warn "================================================================"
  warn "⚠️  Web 客户端缺失（见上面的说明）。服务能起来，但浏览器打开是 404。"
  warn "    先在本机跑 tools/fetch-client.ps1 并重新上传 client/，再继续下一步。"
  warn "================================================================"
fi

if [[ "${REPO_WORLD_WRITABLE:-0}" != "0" ]]; then
  warn "================================================================"
  warn "⚠️  仓库有 $REPO_WORLD_WRITABLE 个 others-可写条目 ⇒ 本地提权面。"
  warn "    （手册让你以 root 跑本脚本，而任何本地用户都能改写它）"
  warn "    立刻修：sudo chmod -R go-w $REPO_ROOT"
  warn "    根治：上传时加 rsync --chmod=D755,F644（部署手册 §7.2）"
  warn "================================================================"
fi

if [[ -n "${REPO_HAS_STRAY:-}" ]]; then
  warn "================================================================"
  warn "⚠️  仓库里有不该上传的目录：$REPO_HAS_STRAY"
  warn "    它们被 .gitignore 忽略，但 rsync 不读 gitignore。"
  warn "    其中 dsh-data 若装过开发态数据，会把本机会话/凭据一起带到服务器。"
  warn "================================================================"
fi
