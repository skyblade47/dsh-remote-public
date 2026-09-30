#!/usr/bin/env bash
# =============================================================================
# assemble-release.sh —— 本地（WSL2）整包装配器
# =============================================================================
#
# 定位：在**本机 WSL2** 上装出**与服务器同形状**的 release 树：
#   <release>/<ver>/{kernel, plugins(13), profile/node_modules(P-A), release.json}
# 然后交给 check-tree-shape.sh 自检、再由 smoke-local-wsl2.sh 起实例冒烟。
#
# 🔴 三条纪律：
#   1. **复用** `kernel-release.sh install`，不重写装包/形状校验/快照/权限逻辑
#      （重写一遍必然漂移，正是 P6a §⑦-7 说的"多处依赖 npm root -g"那种成本）。
#   2. **同一常量只有一个真源**：pnpm 版本从**仓库根 package.json 的 `packageManager`** 读；
#      装配器对版本不符 **fail-closed**（不静默降级）。
#   3. `--offline` 时**必须失败而非静默联网**：npm 与 pnpm 都传 `--offline`，
#      任何"需要联网才能拿到"的包 ⇒ 非 0 退出 ⇒ 本次装配作废（不产出"看起来成功"的树）。
#
# ⚠️ 顺序铁律（本机实测踩出来的）：`kernel-release.sh install` 收尾时会把 release 设成
#   `root:root + u=rwX,go=rX`（P-A 只读前提）⇒ 第三步（pnpm 装第三方）**必须在加固之后再加固一次**，
#   否则要么以非 root 根本写不进去（Permission denied），要么留下可写路径让 P-A 的强保护失效。
#
# 用法：
#   sudo bash deploy/linux/assemble-release.sh --version 0.1.5-rc.1
#   sudo bash deploy/linux/assemble-release.sh --version 0.1.5-rc.1 --offline
#
# 退出码：0=成功  1=用法/环境错误  2=形状自检未过  3=pnpm 版本不符（fail-closed）

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
KR="$REPO_ROOT/deploy/linux/kernel-release.sh"
SHAPE="$REPO_ROOT/deploy/linux/check-tree-shape.sh"
PROFILE_TEMPLATE_DEFAULT="$REPO_ROOT/server/data/templates/profile-web-release.package.json"
# 🔴 路线 B（2026-09-26 用户裁定）：release 的 profile 用**装配形态**三件套 ——
#    package.json 带 `@local/dsh-adapter: link:../plugins/dsh-adapter`（**相对** ⇒ 与版本无关），
#    lockfile 是在**同一形态**下生成的（`@local` 的 link 说明符随形态而变，所以不能用服务器 live 那份）。
LOCKFILE_DEFAULT="$REPO_ROOT/server/data/templates/profile-web-release.pnpm-lock.yaml"
# 🔴 F3：workspace 文件必须与 lockfile **成对**搬运（`overrides` 住在它里面）
WORKSPACE_DEFAULT="$REPO_ROOT/server/data/templates/profile-web.pnpm-workspace.yaml"
EXPECT_NODE_VERSION="22.19.0"
EXPECT_PLUGIN_COUNT=13

VERSION=""
RELEASE_ROOT="${DSH_RELEASE_ROOT:-/usr/local/dsh-release}"
PROFILE_TEMPLATE="$PROFILE_TEMPLATE_DEFAULT"
LOCKFILE="$LOCKFILE_DEFAULT"
WORKSPACE_FILE="$WORKSPACE_DEFAULT"
# 🟢 默认钉点 = 与默认目标版本配对的"传递依赖窗口"（2026-09-27 随 rc.3 更新）。
#    规则：取"该版本发布后、下一版发布前"的中间点，且**必须晚于该版本依赖链上更晚发布的包**。
#    按版本登记：`0.1.5-rc.1 → 2026-09-10T12:00:00Z`；`0.1.5-rc.3 → 2026-09-22T16:00:00Z`。
#    ⚠️ 装**非 rc.3** 的版本时请显式传 `--npm-before`：用 rc.3 的窗口去装 rc.1，会得到
#       "rc.1 内核 + rc.3 期传递依赖"的**混搭树**（版本本身能装上，但依赖不配对）。
NPM_BEFORE="2026-09-22T16:00:00Z"
NPM_MIRROR="https://registry.npmmirror.com"
OFFLINE=0
PNPM_BIN="${DSH_PNPM_BIN:-}"
GIT_COMMIT=""
SKIP_SHAPE=0
ACCEPT_CHANGE=0
SHAPE_ARGS=()

log()  { printf '\033[36m[assemble]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[assemble]\033[0m %s\n' "$*" >&2; }
err()  { printf '\033[31m[assemble]\033[0m %s\n' "$*" >&2; }
die()  { err "$*"; exit 1; }

usage() {
  cat <<'EOF'
用法: assemble-release.sh --version <ver> [选项]

  --version <ver>         目标版本（必填，如 0.1.5-rc.1）
  --release-root <dir>    release 根（默认 /usr/local/dsh-release）
  --profile-template <f>  profile 模板（默认仓库里的 profile-web-release.package.json＝**装配形态**）
  --lockfile <f>          pnpm-lock.yaml（默认仓库里的 profile-web-release.pnpm-lock.yaml＝与模板**同形态**）
  --npm-before <ISO>      内核传递依赖钉点（默认 2026-09-10T12:00:00Z）
  --npm-mirror <url>      npm registry（默认 https://registry.npmmirror.com）
  --pnpm-bin <path>       pnpm 可执行文件（默认 "$(npm prefix -g)/bin/pnpm"）
  --offline               🔴 全程离线：任何需要联网的步骤必须**失败**（不静默联网）
  --git-commit <sha>      写进 release.json.gitCommit（不传则取仓库 HEAD）
  --skip-shape            跳过 check-tree-shape.sh（**仅调试用**，正常别加）
  --accept-change         允许产物相对上次 manifest 发生变化（默认：变化即报错）
  --accept-diff <T-x>     把**已人工裁定**的形状差异项转给 check-tree-shape.sh（可重复）
  --expect-pnpm-entries <n> .pnpm 条目数阈值（转给 check-tree-shape.sh；默认 **225**）
                           ⚠️ 2026-09-26 路线 B 之后：装配形态天然得 225（== 服务器基线），
                           原先 223 那个"降级放行"逃生口**不再需要**。
  --expect-top <n>        顶层条目数阈值（转给 check-tree-shape.sh；默认 **189 = rc.1 基线**）
                           ⚠️ rc.3 = **190**（顶层唯一新增包 `destroy`）⇒ 装 rc.3 请**显式**传 190
                           （**不要**改 check-tree-shape.sh 的默认值去迎合某一个版本）
  -h, --help              显示本帮助

退出码: 0=成功  1=用法/环境错误  2=形状自检未过  3=pnpm 版本不符
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --version)          VERSION="${2:-}"; shift 2 ;;
    --release-root)     RELEASE_ROOT="${2%/}"; shift 2 ;;
    --profile-template) PROFILE_TEMPLATE="${2:-}"; shift 2 ;;
    --lockfile)         LOCKFILE="${2:-}"; shift 2 ;;
    --npm-before)       NPM_BEFORE="${2:-}"; shift 2 ;;
    --npm-mirror)       NPM_MIRROR="${2:-}"; shift 2 ;;
    --pnpm-bin)         PNPM_BIN="${2:-}"; shift 2 ;;
    --offline)          OFFLINE=1; shift ;;
    --git-commit)       GIT_COMMIT="${2:-}"; shift 2 ;;
    --skip-shape)       SKIP_SHAPE=1; shift ;;
    --accept-change)    ACCEPT_CHANGE=1; shift ;;
    --accept-diff)      SHAPE_ARGS+=(--accept-diff "${2:-}"); shift 2 ;;
    --expect-pnpm-entries) SHAPE_ARGS+=(--expect-pnpm-entries "${2:-}"); shift 2 ;;
    --expect-top)       SHAPE_ARGS+=(--expect-top "${2:-}"); shift 2 ;;
    -h|--help)          usage; exit 0 ;;
    *) die "未知参数：$1（用 --help 看用法）" ;;
  esac
done

[[ -n "$VERSION" ]] || die "--version 必填"
[[ "$VERSION" != */* ]] || die "<ver> 不能含 /"

# ---- $HOME 校验（S3 / B4）：fail-fast，放在**参数解析之后、动作之前** ----
# 为什么：本脚本会调用 npm / pnpm / git（以及 `kernel-release.sh install`），它们都按 $HOME
#   定位缓存 / store / 配置；本机实测 $HOME 在某些 WSL 调用里会被污染成 `C:Userszhou1` 这类
#   **非绝对路径** ⇒ 会静默用错缓存或把 store 落到怪路径（装配结果不可信）。
#   `set -uo pipefail` 下 $HOME 可能未定义 ⇒ 用 `${HOME:-}` 兜底再比较。
if [[ "${HOME:-}" != /* ]]; then
  die "\$HOME 不是绝对路径（= '${HOME:-<未定义>}'）⇒ npm/pnpm/git 会按它定位缓存/store/配置，装配结果不可信。
     修法： export HOME=/home/<you> 后重跑；若要固定数据目录，另行显式 export DSH_HOME=<绝对路径>。"
fi

REL="$RELEASE_ROOT/$VERSION"

# ---------------------------------------------------------------- 0) 前置自检

require_root() { [[ "${EUID:-$(id -u)}" -eq 0 ]] || die "请用 root 运行（sudo bash $0 ...）：要写 release 根。"; }

check_node() {
  local cur
  cur="$(node -v 2>/dev/null | sed 's/^v//')" || die "找不到 node"
  [[ "$cur" == "$EXPECT_NODE_VERSION" ]] \
    || die "node 版本不符：本机 $cur，要求 $EXPECT_NODE_VERSION（与服务器同版本；形状基线是按它实测的）"
  log "node v$cur ✓"
}

# 🔴 pnpm 版本真源 = 仓库根 package.json 的 packageManager（**唯一真源**，见 lib/pnpm-version.sh）
source "$REPO_ROOT/deploy/linux/lib/pnpm-version.sh"

resolve_pnpm() {
  local want_bin="$1" want got
  if [[ -z "$want_bin" ]]; then want_bin="$(npm prefix -g)/bin/pnpm"; fi
  PNPM_BIN="$want_bin"
  [[ -x "$PNPM_BIN" ]] || die "pnpm 不存在或不可执行：$PNPM_BIN
     ⚠️ 本机实测：全局 pnpm 若被截断会 **SIGSEGV**（rc 139）。修法：
       npm i -g --prefix \"\$HOME/pnpm1251\" pnpm@<钉版>   # 装到可写前缀
       然后用 --pnpm-bin \"\$HOME/pnpm1251/bin/pnpm\" 指定"
  want="$(pnpm_pinned_version)" || die "读不到 pnpm 钉版（真源 = package.json#packageManager）"
  got="$("$PNPM_BIN" --version 2>/dev/null || true)"
  [[ "$got" == "$want" ]] \
    || { err "pnpm 版本不符：$PNPM_BIN 报 '$got'，packageManager 要求 '$want' ⇒ **fail-closed，拒绝装配**"; exit 3; }
  log "pnpm $got ✓（$PNPM_BIN，真源 = package.json#packageManager）"
}

# ---------------------------------------------------------------- 1) 内核（复用 kernel-release.sh install）

install_kernel() {
  local args=(install "$VERSION" --npm-before "$NPM_BEFORE" --profile-template "$PROFILE_TEMPLATE")
  [[ -f "$KR" ]] || die "找不到 $KR"
  [[ -f "$PROFILE_TEMPLATE" ]] || die "找不到 profile 模板：$PROFILE_TEMPLATE"
  [[ -n "$GIT_COMMIT" ]] && args+=(--git-commit "$GIT_COMMIT")
  [[ "$OFFLINE" == "1" ]] && args+=(--npm-offline)
  log "复用 kernel-release.sh install（args: ${args[*]}）"
  DSH_RELEASE_ROOT="$RELEASE_ROOT" bash "$KR" "${args[@]}" \
    || die "kernel-release.sh install 失败（离线模式下多为 store/缓存未预热 ⇒ 这是 **fail-closed 的正确行为**，不是 bug）"
}

# ---------------------------------------------------------------- 2) 自研插件（install 已快照；这里只核对）

check_plugins() {
  local n vr
  # ⚠️ 必须排除 node_modules：kernel-release.sh 4b) 的宿主包接线会把它建出来，不排除会数成 14。
  n="$(find "$REL/plugins" -mindepth 1 -maxdepth 1 -type d ! -name node_modules 2>/dev/null | wc -l)"
  [[ "$n" -eq "$EXPECT_PLUGIN_COUNT" ]] || die "自研插件数不符：$n（期望 $EXPECT_PLUGIN_COUNT，含 version-radar）"
  [[ -d "$REL/plugins/version-radar" ]] || die "缺 version-radar（Spec① 约束 2：@local/* 会断链）"
  # F1：宿主包接线必须存在且**落在本 release 内**（否则插件 ESM 解析不到 @deepseek-ai/dsh-tools）
  local w="$REL/plugins/node_modules/@deepseek-ai/dsh-tools"
  [[ -e "$w/package.json" ]] || die "缺宿主包接线：$w（插件会报 Cannot find package '@deepseek-ai/dsh-tools'）"
  case "$(readlink -f "$w" 2>/dev/null || true)" in
    "$REL"/*) : ;;
    *) die "宿主包接线指向 release 之外：$(readlink -f "$w" 2>/dev/null)（期望落在 $REL/ 内）" ;;
  esac
  vr="$(node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).version))' "$REL/plugins/version-radar/package.json" 2>/dev/null || echo '?')"
  log "自研插件 $n 个（含 version-radar@$vr）+ 宿主包接线 ✓"
}

# ---------------------------------------------------------------- 3) 第三方（P-A 形态）

install_third_party() {
  local prof="$REL/profile"
  mkdir -p "$prof"
  # install 已把 profile 模板写成 profile/package.json；若没有则补
  [[ -f "$prof/package.json" ]] || install -m 0644 "$PROFILE_TEMPLATE" "$prof/package.json"

  local have_lock=0
  if [[ -f "$LOCKFILE" ]]; then
    install -m 0644 "$LOCKFILE" "$prof/pnpm-lock.yaml"; have_lock=1
    log "用仓库里的 lockfile：$LOCKFILE"
  elif [[ -f "$prof/pnpm-lock.yaml" ]]; then
    LOCKFILE="$prof/pnpm-lock.yaml"; have_lock=1
    log "用 release 内已有的 lockfile：$LOCKFILE"
  fi

  local args=(install)
  # 🔴 F3：`pnpm-workspace.yaml` 与 lockfile **必须成对** —— `overrides` 住在 workspace 文件里，
  #    只搬 lockfile ⇒ pnpm 报 `the current "overrides" configuration doesn't match the value
  #    found in the lockfile` 并**拒绝安装**（本机实测 rc=1）。这是 V1 FAIL 的第二个原因。
  if [[ -f "$WORKSPACE_FILE" ]]; then
    install -m 0644 "$WORKSPACE_FILE" "$prof/pnpm-workspace.yaml"
    log "用仓库里的 pnpm-workspace.yaml（与 lockfile 成对）：$WORKSPACE_FILE"
  else
    warn "找不到 $WORKSPACE_FILE ⇒ pnpm 会因 overrides 不匹配而拒绝（F3）"
  fi
  if [[ "$have_lock" == "1" ]]; then
    args+=(--frozen-lockfile)
  elif [[ "$OFFLINE" == "1" ]]; then
    die "🔴 --offline 但没有 pnpm-lock.yaml：无法 --frozen-lockfile ⇒ **fail-closed**。
     先联网跑一次（不带 --offline）生成 lockfile，或用 --lockfile <path> 指定。"
  else
    warn "没有 pnpm-lock.yaml：本次会**联网解析并生成**它（之后请把 $prof/pnpm-lock.yaml 归档，作为唯一钉点）"
  fi
  if [[ "$OFFLINE" == "1" ]]; then args+=(--offline); fi
  # --ignore-scripts：pnpm 12 对本仓库的 node-pty 会报 ERR_PNPM_IGNORED_BUILDS 并**退出码 1**
  #   （实测：树其实已装好、退出码却是 1）。文档明确该 flag 表示"仅跳过 build script、不因此失败"。
  args+=(--ignore-scripts --registry="$NPM_MIRROR")

  log "在 $prof 跑 pnpm ${args[*]}"
  ( cd "$prof" && "$PNPM_BIN" "${args[@]}" ) \
    || die "pnpm install 失败（离线模式下的 'snapshot not present in local store' = fail-closed 正确行为）"

  if [[ "$have_lock" == "0" && -f "$prof/pnpm-lock.yaml" ]]; then
    mkdir -p "$(dirname "$LOCKFILE")"
    install -m 0644 "$prof/pnpm-lock.yaml" "$LOCKFILE"
    log "已把生成的 lockfile 归档到 $LOCKFILE（下次即可 --frozen-lockfile / --offline）"
  fi
}

# ---------------------------------------------------------------- 3b) 权限加固（**必须放在第三步之后**）
#
# 🔴 为什么必须放在第三方装配**之后**：`kernel-release.sh install` 在它自己收尾时
#    已经 `chown -R root:root` + `chmod -R u=rwX,go=rX`（P-A 的"只读快照"前提）。
#    此后第三步要在 `<release>/<ver>/profile/` 里新建 `node_modules`（367 MiB）——
#    那批新文件**不会**继承"只读"，而且以非 root 身份根本写不进去（实测：Permission denied）。
#    ⇒ 顺序必须是「先装配 ⇒ 再统一加固 ⇒ 再自检」，否则要么写不进、要么留下可写路径
#      （后者会让 P-A 的强保护失效：heal 想写就能写，boot 不再崩）。
harden_permissions() {
  local svc="${DSH_SERVICE_USER:-}"
  chown -R root:root "$REL"
  chmod -R u=rwX,go=rX "$REL"
  log "权限已加固：root:root + u=rwX,go=rX ✓"
  if [[ -n "$svc" ]] && command -v runuser >/dev/null 2>&1; then
    runuser -u "$svc" -- test -r "$REL/kernel/lib/node_modules/@deepseek-ai/dsh/package.json" \
      || die "服务用户 $svc 读不到 release（权限/祖先目录）⇒ 内核只会报 cannot resolve profile bundle"
    local w
    w="$(runuser -u "$svc" -- find "$REL" -writable -print -quit 2>/dev/null || true)"
    [[ -z "$w" ]] || die "release 里还有服务用户**可写**的路径：$w ⇒ 违反 P-A 只读前提"
    log "只读前提自检 ✓（服务用户 $svc 可读、无可写路径）"
  fi
}

# ---------------------------------------------------------------- 4) release.json 追加

augment_release_json() {
  local rj="$REL/release.json"
  [[ -f "$rj" ]] || die "install 未产出 release.json：$rj"
  node -e '
    const fs = require("fs")
    const [file, rel, prof, lock, pnpmBin, pnpmVer, offline] = process.argv.slice(1)
    const j = JSON.parse(fs.readFileSync(file, "utf8"))

    // 4 个第三方：在 P-A 形态下从 profile/node_modules 读**实装版本** + 记录 storeEntry（.pnpm 目录名）
    const names = ["@huanlin/dsh-plugin-better-locale", "@nanmicoder/dsh-agent-teams", "dsh-better-sidebar", "dshmarket"]
    const third = names.map((name) => {
      let version = null
      try { version = JSON.parse(fs.readFileSync(`${prof}/node_modules/${name}/package.json`, "utf8")).version } catch (e) {}
      let storeEntry = null
      try {
        const enc = name.replace("/", "+")
        storeEntry = fs.readdirSync(`${prof}/node_modules/.pnpm`)
          .filter((d) => d.startsWith(enc + "@") || d.startsWith(name + "@"))[0] || null
      } catch (e) {}
      return { name, version, storeEntry }
    })

    j.thirdParty = third
    j.lockfileSha256 = (() => {
      try {
        return require("crypto").createHash("sha256").update(fs.readFileSync(lock)).digest("hex")
      } catch (e) { return null }
    })()
    j.pnpmVersion = pnpmVer
    j.assemble = { by: "assemble-release.sh", offline: offline === "1", at: new Date().toISOString(), nodeVersion: process.version, pnpmBin }
    fs.writeFileSync(file, JSON.stringify(j, null, 2) + "\n", { mode: 0o644 })
  ' "$rj" "$REL" "$REL/profile" "$REL/profile/pnpm-lock.yaml" "$PNPM_BIN" "$("$PNPM_BIN" --version)" "$OFFLINE"
  log "release.json 已追加 thirdParty[]（实装版本 + storeEntry）/ lockfileSha256 / pnpmVersion / assemble ✓"
}

# ---------------------------------------------------------------- 5) 幂等（产物 sha256 清单）

content_manifest() {
  # ⚠️ 有**两处时间戳是每次运行必变**的，若原样纳入清单，幂等核对**永远不可能绿**
  #    （计划 Task 4 Step 4 的 Expected 明写第二次运行应得 `幂等核对 ✓` ⇒ 按该意图把"时间戳"排除在"内容"之外）：
  #      ① release.json 的 `installedAt` —— `kernel-release.sh install` **每次**都无条件重写它
  #         （它写 `date -u` 的当前秒，并顺带丢掉我们追加的 `assemble`），本装配器随后再写 `assemble.at`；
  #      ② profile/node_modules/.pnpm-workspace-state-v1.json 的 `lastValidatedTimestamp` —— pnpm 每次 install 刷新。
  #     二者都是簿记/时间戳，不是发布内容；下面对 release.json 按"去掉这两个字段"后的规范化 JSON 取 sha256。
  local relnorm
  relnorm="$( cd "$REL" && node -e '
    const fs = require("fs"), crypto = require("crypto")
    const j = JSON.parse(fs.readFileSync("release.json", "utf8"))
    delete j.installedAt
    if (j.assemble) delete j.assemble.at
    process.stdout.write(crypto.createHash("sha256").update(JSON.stringify(j)).digest("hex"))
  ' 2>/dev/null || true )"
  {
    ( cd "$REL" && find kernel plugins profile \( -type f -o -type l \) \
        -not -path '*/.pnpm-workspace-state-v1.json' -print0 2>/dev/null \
        | sort -z | xargs -0 sha256sum 2>/dev/null )
    [[ -n "$relnorm" ]] && printf '%s  release.json(normalized, 去 installedAt/assemble.at)\n' "$relnorm"
  }
}

check_idempotent() {
  local mf="$REL/assembly-manifest.sha256" now
  now="$(content_manifest)"
  if [[ -f "$mf" ]]; then
    if [[ "$now" == "$(cat "$mf")" ]]; then
      log "幂等核对 ✓（产物清单与上次逐行一致）"
    elif [[ "$ACCEPT_CHANGE" == "1" ]]; then
      warn "产物清单与上次**不同**，但给了 --accept-change ⇒ 接受并覆盖 manifest"
      printf '%s\n' "$now" > "$mf"
    else
      die "🔴 产物清单与上次**不同**（非幂等）。差异行：
$(diff <(printf '%s\n' "$now") "$mf" | head -20)
     若差异是预期的（例如上游发了新版），用 --accept-change 重跑并归档原因。"
    fi
  else
    printf '%s\n' "$now" > "$mf"
    log "首次写入产物清单：$mf（下次运行会拿它做幂等核对）"
  fi
}

# ---------------------------------------------------------------- main
# ⚠️ 顺序刻意如此：**先做不需要 root 的 fail-closed 检查**（node 版本、pnpm 钉版），
#    再要 root。这样"pnpm 版本不符被拒"可以在**不 sudo** 的情况下被测试到。
check_node
resolve_pnpm "$PNPM_BIN"
require_root
install_kernel
check_plugins
install_third_party
harden_permissions
augment_release_json
check_idempotent

if [[ "$SKIP_SHAPE" == "1" ]]; then
  warn "已跳过形状自检（--skip-shape）⇒ **不得据此起实例**（树形状不对会 crash-loop，而探针可能全绿）"
else
  log "形状自检（check-tree-shape.sh）"
  bash "$SHAPE" --version "$VERSION" --release-root "$RELEASE_ROOT" --emit-fixture "${SHAPE_ARGS[@]+"${SHAPE_ARGS[@]}"}"
  rc=$?
  [[ "$rc" -eq 0 ]] || { err "形状自检未过（rc=$rc）⇒ 不得起实例"; exit 2; }
fi

log "✅ 装配完成：$REL"
log "   下一步：sudo bash deploy/linux/smoke-local-wsl2.sh --version $VERSION --release-root $RELEASE_ROOT"
