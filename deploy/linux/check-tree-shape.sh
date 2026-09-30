#!/usr/bin/env bash
# =============================================================================
# check-tree-shape.sh —— release 树「形状自检」（判据 T-1 … T-9）
# =============================================================================
#
# 为什么必须有它（不是"多一层检查"）：
#   内核的插件加载器**要求依赖树是顶层扁平**的。上游发版会让 npm 把
#   `@deepseek-ai/*` 嵌进 `<pkg>/node_modules/@deepseek-ai/`（嵌套形态）——
#   这种树内核启动后会 **crash-loop**，而 `check-ready.sh` 那类探针在它崩溃前
#   采样的那几秒**会报全绿**（2026-09-23 真实事故）。⇒ **探针全绿 ≠ 树是对的**。
#   ⇒ 必须在"装完"与"起实例"之间插一道机器判据。
#
# 判据总表（与服务器 2026-09-26 实测基线逐项对齐）：
#   T-1  <dsh>/package.json.version == 目标版本
#   T-2  <dsh>/node_modules 顶层条目数（**不含点文件**，`.bin` 不计）== 189
#        （189 = **0.1.5-rc.1 基线**；rc.3 = **190**，顶层唯一新增包 `destroy`
#         ⇒ 用 `--expect-top 190`。默认值**不随版本静默改**，差异必须人工裁定）
#   T-3  <dsh> 体积 ≈ 305 MiB（±tol%）
#   T-4  🔴 <dsh>/node_modules/@deepseek-ai/dsh-base/node_modules/@deepseek-ai 条目数 == 0
#   T-5  <release>/<ver>/plugins/ 目录数 == 13（含 version-radar）
#   T-6  <release>/<ver>/profile/node_modules 里 4 个第三方版本 == 期望集合
#   T-7  <release>/<ver>/profile/node_modules/.pnpm 条目数 == 225
#   T-8  🔴 <release>/<ver>/plugins/node_modules/@deepseek-ai/dsh-tools 存在（相对链）**且解析落在本 release 内**
#        （F1：没有它 ⇒ 插件 ESM 解析不到宿主包 ⇒ `loaded=1 failed=14`）
#   T-9  🔴 profile 下 `pnpm-lock.yaml` 与 `pnpm-workspace.yaml` **成对**且 overrides 一致
#        （F3：只搬 lockfile ⇒ pnpm 以"overrides 不匹配"为由拒绝安装）
#
# 🔴 差异一律"显式记录 + 人工裁定"，**不许自动跳过**：
#   阈值随版本变（上游发新版 ⇒ 条目数/体积都会变）。默认任何 FAIL 即 **exit 2**；
#   只有对**已人工裁定**的项用 `--accept-diff <T-x>` 显式降级为 DIFF（仍打印、仍留痕）。
#
# 退出码：0=全过（或差异已裁定） 1=用法/环境错误 2=有未裁定的 FAIL
#
# 用法：
#   bash deploy/linux/check-tree-shape.sh --version 0.1.5-rc.1
#   bash deploy/linux/check-tree-shape.sh --version 0.1.5-rc.3 --expect-top 190
#   bash deploy/linux/check-tree-shape.sh --version 0.1.5-rc.1 --accept-diff T-7 --expect-pnpm-entries 223
#   bash deploy/linux/check-tree-shape.sh --version 0.1.5-rc.1 --emit-fixture

set -uo pipefail

RELEASE_ROOT="${DSH_RELEASE_ROOT:-/usr/local/dsh-release}"
VERSION=""
# ---- 默认阈值（按版本登记；**默认值 = rc.1 基线，不静默改**）----
#   🔴 T-2 顶层条目数随上游发版而变，差异**必须人工裁定**（不许自动跳过）：
#       0.1.5-rc.1 → 189（本机/服务器一致）
#       0.1.5-rc.3 → 190（顶层**唯一**新增条目 = `destroy`；其余 T-1/T-3…T-9 两版相同）
#     装 rc.3 请**显式** `--expect-top 190`；**不要**为了让某个版本过就改这里的默认值。
EXPECT_TOP="${DSH_SHAPE_TOP:-189}"
EXPECT_SIZE_MIB="${DSH_SHAPE_SIZE_MIB:-305}"
SIZE_TOL_PCT="${DSH_SHAPE_SIZE_TOL_PCT:-2}"
EXPECT_PLUGINS="${DSH_SHAPE_PLUGINS:-13}"
# 🟢 2026-09-27 更新（窗口项 W10）：第三方钉版集合由 `0.4.1,0.1.20,0.19.1,1.47.0` →
#    `0.4.3,0.1.21,0.19.1,1.47.0`（agent-teams 0.1.21 的 peer 七段枚举含 0.1.5-rc.2/rc.3、
#    better-locale 0.4.3 的 `^0.1.5-rc.2` 覆盖 rc.3 ⇒ 由"声明不支持、实测可用"变为"声明支持"）。
#    依据与证据：docs/superpowers/specs/2026-09-27-third-party-compat-and-host-upgrade-assessment.md
#                docs/superpowers/evidence/2026-09-27-third-party-bump-wsl2-smoke/SUMMARY.md
EXPECT_THIRD="${DSH_SHAPE_THIRD:-0.4.3,0.1.21,0.19.1,1.47.0}"
EXPECT_PNPM_ENTRIES="${DSH_SHAPE_PNPM_ENTRIES:-225}"
EMIT_FIXTURE=0
ACCEPT_DIFF=()

log()  { printf '[shape] %s\n' "$*"; }
err()  { printf '[shape] %s\n' "$*" >&2; }

usage() {
  cat <<'EOF'
用法: check-tree-shape.sh --version <ver> [选项]

  --version <ver>             目标版本（必填；也决定 <release>/<ver> 路径）
  --release-root <dir>        release 根（默认 /usr/local/dsh-release）
  --expect-top <n>            顶层条目数期望（默认 189 = rc.1 基线；rc.3 用 190）
  --expect-size-mib <n>       内核体积期望 MiB（默认 305）
  --size-tol-pct <n>          体积容差百分比（默认 2）
  --expect-plugins <n>        自研插件目录数期望（默认 13）
  --expect-third <v1,v2,...>  4 个第三方版本期望集合（默认 0.4.1,0.1.20,0.19.1,1.47.0）
  --expect-pnpm-entries <n>   .pnpm 条目数期望（默认 225）
  --accept-diff <T-x>         把**已人工裁定**的差异项降级为 DIFF（可重复；仍打印）
  --emit-fixture              末尾打印"交给 Spec① 夹具 B 用"的路径 + 权限步骤
  -h, --help                  显示本帮助

退出码: 0=全过/差异已裁定  1=用法或环境错误  2=有未裁定的 FAIL
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --version)            VERSION="${2:-}"; shift 2 ;;
    --release-root)       RELEASE_ROOT="${2%/}"; shift 2 ;;
    --expect-top)         EXPECT_TOP="${2:-}"; shift 2 ;;
    --expect-size-mib)    EXPECT_SIZE_MIB="${2:-}"; shift 2 ;;
    --size-tol-pct)       SIZE_TOL_PCT="${2:-}"; shift 2 ;;
    --expect-plugins)     EXPECT_PLUGINS="${2:-}"; shift 2 ;;
    --expect-third)       EXPECT_THIRD="${2:-}"; shift 2 ;;
    --expect-pnpm-entries) EXPECT_PNPM_ENTRIES="${2:-}"; shift 2 ;;
    --accept-diff)        ACCEPT_DIFF+=("${2:-}"); shift 2 ;;
    --emit-fixture)       EMIT_FIXTURE=1; shift ;;
    -h|--help)            usage; exit 0 ;;
    *) err "未知参数：$1"; usage >&2; exit 1 ;;
  esac
done

[[ -n "$VERSION" ]] || { err "--version 必填"; usage >&2; exit 1; }
[[ "$VERSION" != */* ]] || { err "<ver> 不能含 /"; exit 1; }
command -v node >/dev/null 2>&1 || { err "缺少 node"; exit 1; }

REL="$RELEASE_ROOT/$VERSION"
DSH="$REL/kernel/lib/node_modules/@deepseek-ai/dsh"
FLAT_DIR="$DSH/node_modules/@deepseek-ai/dsh-base/node_modules/@deepseek-ai"
THIRD_DIR="$REL/profile/node_modules"
PNPM_DIR="$THIRD_DIR/.pnpm"

[[ -d "$REL" ]] || { err "release 版本目录不存在：$REL"; exit 1; }

FAILS=()
DIFFS=()
is_accepted() { local x; for x in "${ACCEPT_DIFF[@]+"${ACCEPT_DIFF[@]}"}"; do [[ "$x" == "$1" ]] && return 0; done; return 1; }

declare_item() {  # $1=编号 $2=标题 $3=是否通过(0/1) $4=明细
  if [[ "$3" == "0" ]]; then
    printf '  %-5s PASS  %s —— %s\n' "$1" "$2" "$4"
  elif is_accepted "$1"; then
    printf '  %-5s DIFF  %s —— %s（**已人工裁定，降级**）\n' "$1" "$2" "$4"
    DIFFS+=("$1")
  else
    printf '  %-5s FAIL  %s —— %s\n' "$1" "$2" "$4"
    FAILS+=("$1")
  fi
}

log "release 根 = $RELEASE_ROOT · 版本 = $VERSION"

# ---- T-1 版本 ----
v=""
pkg="$DSH/package.json"
[[ -f "$pkg" ]] && v="$(node -e 'try{process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).version))}catch(e){}' "$pkg" 2>/dev/null || true)"
if [[ "$v" == "$VERSION" ]]; then declare_item T-1 "内核版本" 0 "$v"; else declare_item T-1 "内核版本" 1 "期望 $VERSION，实际 '${v:-未读到}'（$pkg）"; fi

# ---- T-2 顶层条目数（**不含点文件**；`.bin` 不计）----
#   本机实测（rc.1）：`find -not -name '.*'` = 189，`ls -1` 也 = 189（`ls -a` = 192）⇒ 两个口径一致。
#   ⚠️ rc.3 = 190（顶层新增 `destroy`）⇒ 数出来 190 时**别改这里的默认值**，传 `--expect-top 190`。
top=""
[[ -d "$DSH/node_modules" ]] && top="$(find "$DSH/node_modules" -mindepth 1 -maxdepth 1 -not -name '.*' 2>/dev/null | wc -l)"
if [[ "${top:-0}" -eq "$EXPECT_TOP" ]]; then declare_item T-2 "顶层条目数" 0 "$top"; else declare_item T-2 "顶层条目数" 1 "期望 $EXPECT_TOP，实际 '${top:-0}'（上游发版会变 ⇒ 需人工裁定）"; fi

# ---- T-3 内核体积（±tol%）----
mib=""
[[ -d "$DSH" ]] && mib="$(du -sm "$DSH" 2>/dev/null | awk '{print $1}')"
lo=$(( EXPECT_SIZE_MIB * (100 - SIZE_TOL_PCT) / 100 ))
hi=$(( (EXPECT_SIZE_MIB * (100 + SIZE_TOL_PCT) + 99) / 100 ))
if [[ -n "$mib" ]] && (( mib >= lo && mib <= hi )); then
  declare_item T-3 "内核体积" 0 "${mib} MiB（期望 ${EXPECT_SIZE_MIB}±${SIZE_TOL_PCT}% ⇒ ${lo}–${hi}）"
else
  declare_item T-3 "内核体积" 1 "实际 '${mib:-?}' MiB，期望 ${EXPECT_SIZE_MIB}±${SIZE_TOL_PCT}% ⇒ ${lo}–${hi}"
fi

# ---- T-4 🔴 树扁平 ----
flat=0
[[ -d "$FLAT_DIR" ]] && flat="$(find "$FLAT_DIR" -mindepth 1 -maxdepth 1 2>/dev/null | wc -l)"
if [[ "${flat:-0}" -eq 0 ]]; then
  declare_item T-4 "树扁平（dsh-base 下嵌套 @deepseek-ai）" 0 "0 条"
else
  declare_item T-4 "树扁平（dsh-base 下嵌套 @deepseek-ai）" 1 "$flat 条 ⇒ 🔴 依赖树已嵌套，**启动即 crash-loop 而探针可能全绿**；换一个可用的 --npm-before 重装"
fi

# ---- T-5 自研插件目录数（含 version-radar）----
# ⚠️ 必须**排除 node_modules**：F1 的宿主包接线会把 `plugins/node_modules/` 建出来
#    （`<release>/<ver>/plugins/node_modules/@deepseek-ai/dsh-tools`），不排除会把 13 数成 14。
pdir="$REL/plugins"
pcount=0
[[ -d "$pdir" ]] && pcount="$(find "$pdir" -mindepth 1 -maxdepth 1 -type d ! -name node_modules 2>/dev/null | wc -l)"
hasvr=0
[[ -d "$pdir/version-radar" ]] && hasvr=1
if [[ "${pcount:-0}" -eq "$EXPECT_PLUGINS" && "$hasvr" -eq 1 ]]; then
  declare_item T-5 "自研插件目录数" 0 "$pcount 个（含 version-radar）"
elif [[ "$hasvr" -eq 0 ]]; then
  # 🔴 缺 version-radar ⇒ 无论总数是否等于期望值，都必须**点名**它（Spec① 约束 2：@local/* 会断链）
  declare_item T-5 "自研插件目录数" 1 "${pcount:-0} 个，但**缺 version-radar**（Spec① 约束 2：@local/* 会断链；期望 $EXPECT_PLUGINS 个）"
else
  declare_item T-5 "自研插件目录数" 1 "期望 $EXPECT_PLUGINS，实际 '${pcount:-0}'"
fi

# ---- T-6 4 个第三方版本 ----
third_names=( "@huanlin/dsh-plugin-better-locale" "@nanmicoder/dsh-agent-teams" "dsh-better-sidebar" "dshmarket" )
got_versions=""
detail=""
for n in "${third_names[@]}"; do
  vv="$(node -e 'try{process.stdout.write(String(require(process.argv[1]+"/package.json").version))}catch(e){process.stdout.write("MISSING")}' "$THIRD_DIR/$n" 2>/dev/null || echo MISSING)"
  got_versions+="$vv"$'\n'
  detail+="$n=$vv "
done
exp_sorted="$(printf '%s\n' "${EXPECT_THIRD//,/ }" | tr ' ' '\n' | sed '/^$/d' | sort | tr '\n' ' ' | sed 's/ $//')"
got_sorted="$(printf '%s' "$got_versions" | sed '/^$/d' | sort | tr '\n' ' ' | sed 's/ $//')"
if [[ "$got_sorted" == "$exp_sorted" ]]; then declare_item T-6 "第三方 4 个版本" 0 "$detail"; else declare_item T-6 "第三方 4 个版本" 1 "实际 [$got_sorted]，期望 [$exp_sorted]"; fi

# ---- T-7 profile/node_modules 存在 + .pnpm 条目数 ----
if [[ ! -d "$THIRD_DIR" ]]; then
  declare_item T-7 "profile/node_modules(.pnpm 条目数)" 1 "目录不存在：$THIRD_DIR（P-A 形态未装配）"
else
  pe=0
  [[ -d "$PNPM_DIR" ]] && pe="$(find "$PNPM_DIR" -mindepth 1 -maxdepth 1 -not -name '.*' 2>/dev/null | wc -l)"
  if [[ "${pe:-0}" -eq "$EXPECT_PNPM_ENTRIES" ]]; then
    declare_item T-7 "profile/node_modules(.pnpm 条目数)" 0 "$pe"
  else
    declare_item T-7 "profile/node_modules(.pnpm 条目数)" 1 "期望 $EXPECT_PNPM_ENTRIES，实际 '${pe:-0}'（⚠️ 本机实测 **223**，服务器实测 **225** ⇒ 差异必须人工裁定，见计划 §自查-4 G5）"
  fi
fi

# ---- T-8 🔴 宿主包接线（F1）----
# 为什么单独立判据：这是"release 只读可启动"的必要条件之一（Spec① 的核心命题）。
# 判两件：① 链存在且可解析（`@deepseek-ai/dsh-tools/package.json` 读得到）；
#        ② `readlink -f` **落在本 release 内** —— 不许指向 /opt 或仓库（实测：服务器 live 侧
#           那条链正指向**旧全局安装** `/usr/local/node-v22.19.0-linux-x64/...`，属版本混用）。
WIRE="$REL/plugins/node_modules/@deepseek-ai/dsh-tools"
if [[ ! -e "$WIRE/package.json" ]]; then
  declare_item T-8 "宿主包接线(@deepseek-ai/dsh-tools)" 1 "不存在/不可解析：$WIRE ⇒ 插件会报 Cannot find package '@deepseek-ai/dsh-tools'"
else
  wire_real="$(readlink -f "$WIRE" 2>/dev/null || true)"
  case "$wire_real" in
    "$REL"/*) declare_item T-8 "宿主包接线(@deepseek-ai/dsh-tools)" 0 "$wire_real" ;;
    *)        declare_item T-8 "宿主包接线(@deepseek-ai/dsh-tools)" 1 "解析到 release **之外**：${wire_real:-?}（期望落在 $REL/ 内）" ;;
  esac
fi

# ---- T-9 🔴 lockfile 与 pnpm-workspace.yaml 成对（F3）----
# 为什么必须成对：`overrides` 住在 workspace 文件里，lockfile 第 7 行起也记着同一份；
# 只搬 lockfile ⇒ pnpm 报 `the current "overrides" configuration doesn't match the value
# found in the lockfile` 并**拒绝安装**（本机实测 rc=1）。
PROF_DIR="$REL/profile"
if [[ ! -f "$PROF_DIR/pnpm-lock.yaml" ]]; then
  declare_item T-9 "lockfile 与 workspace 成对" 1 "缺 $PROF_DIR/pnpm-lock.yaml"
elif [[ ! -f "$PROF_DIR/pnpm-workspace.yaml" ]]; then
  declare_item T-9 "lockfile 与 workspace 成对" 1 "缺 $PROF_DIR/pnpm-workspace.yaml（F3：overrides 就在它里面，pnpm 会拒绝安装）"
else
  wo="$(awk '/^overrides:/{f=1;next} f&&/^[^ ]/{f=0} f' "$PROF_DIR/pnpm-workspace.yaml" | sed 's/^ *//' | sed '/^$/d' | sort)"
  lo="$(awk '/^overrides:/{f=1;next} f&&/^[^ ]/{f=0} f' "$PROF_DIR/pnpm-lock.yaml"    | sed 's/^ *//' | sed '/^$/d' | sort)"
  if [[ "$wo" == "$lo" ]]; then
    declare_item T-9 "lockfile 与 workspace 成对" 0 "overrides 一致：${wo:-（两边都无 overrides）}"
  else
    declare_item T-9 "lockfile 与 workspace 成对" 1 "overrides 不一致：workspace=[$wo] lockfile=[$lo]"
  fi
fi

echo
if [[ ${#FAILS[@]} -gt 0 ]]; then
  err "❌ 形状自检未过：${FAILS[*]}（共 ${#FAILS[@]} 项）"
  err "   差异必须**显式记录 + 人工裁定**：确认无误后用 --accept-diff <T-x> 重跑（会打印 DIFF 并留痕）。"
  exit 2
fi
if [[ ${#DIFFS[@]} -gt 0 ]]; then
  log "✅ 形状自检通过（含已裁定差异：${DIFFS[*]}）"
else
  log "✅ 形状自检全过（T-1 … T-9）"
fi

if [[ "$EMIT_FIXTURE" == "1" ]]; then
  echo
  echo "===== 交给 Spec①「夹具 B（heal 零写入）」的接口 ====="
  echo "release 绝对路径 : $REL"
  echo "内核入口         : $REL/kernel/lib/node_modules/@deepseek-ai/dsh/lib/bin.js"
  echo "权限（只读形态） :"
  echo "  sudo chown -R root:root \"$REL\""
  echo "  sudo chmod -R u=rwX,go=rX \"$REL\""
  echo "  # 验证：非 root 用户可读、不可写"
  echo "  sudo -u \$USER test -r \"$REL/kernel/lib/node_modules/@deepseek-ai/dsh/package.json\" && echo readable"
  echo "  sudo -u \$USER find \"$REL\" -writable -print -quit   # 期望：无输出"
  echo "权限（切回可写对照）:"
  echo "  sudo chown -R \$(id -u):\$(id -g) \"$REL\""
fi
exit 0
