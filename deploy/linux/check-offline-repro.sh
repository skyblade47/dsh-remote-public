#!/usr/bin/env bash
# =============================================================================
# check-offline-repro.sh —— 离线可复现判据 O-1 … O-4
# =============================================================================
#
# 背景（整包式设计 §A.3 #11「❓ 未验」）：只知道服务器**出网通**，
#   `pnpm install --frozen-lockfile` **能否离线**从来没查过。
#   而 P-A/P-B 都依赖它 ⇒ 必须把"能不能离线"落成**实测结论**。
#
# 判据：
#   O-1 先在**联网**下拉一遍（预热 store + 确认 lockfile 可用）          → 期望 rc 0
#   O-2 删掉 node_modules 后 `--frozen-lockfile --offline`            → **rc 0 或明确失败**
#       （🔴 **不接受静默降级**：离线时若它偷偷走了网络，我们无从发现 ⇒ 必须"要么成、要么响"）
#   O-3 与联网那次的产物比对（**顺序无关**的清单 + .pnpm 条目数）        → 一致
#   O-4 打印"离线能不能成"的**实测结论**（含耗时/条目数/体积/lockfile 是否被改动）
#
# 🔴 反证（**必须一起做**，否则"离线成功"可能是假绿）：
#   用一个**空的 store** 再跑一次 `--offline` ⇒ **必须失败**（证明 --offline 真的生效了）。
#
# 用法：
#   bash deploy/linux/check-offline-repro.sh --pnpm-bin "$HOME/pnpm1251/bin/pnpm"
#   bash deploy/linux/check-offline-repro.sh --profile-source /usr/local/dsh-release/0.1.5-rc.1/profile
#
# 退出码：0=O-1…O-4 全过（含反证） 1=用法/环境错误 2=有判据不过

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PROFILE_TEMPLATE_DEFAULT="$REPO_ROOT/server/data/templates/profile-web-minimal.package.json"
LOCKFILE_DEFAULT="$REPO_ROOT/server/data/templates/profile-web-minimal.pnpm-lock.yaml"
NPM_MIRROR="https://registry.npmmirror.com"

PNPM_BIN="${DSH_PNPM_BIN:-}"
PROFILE_SOURCE=""
SCRATCH="${DSH_OFFLINE_SCRATCH:-/tmp/dsh-offline-repro}"
EVIDENCE=""

log()  { printf '\033[36m[offline]\033[0m %s\n' "$*"; }
err()  { printf '\033[31m[offline]\033[0m %s\n' "$*" >&2; }

usage() {
  cat <<'EOF'
用法: check-offline-repro.sh [选项]

  --pnpm-bin <path>        pnpm 可执行文件（默认 "$(npm prefix -g)/bin/pnpm"）
  --profile-source <dir>   从该目录取 package.json / pnpm-lock.yaml
                           （默认用仓库模板目录里的 profile-web-minimal.*）
  --scratch <dir>          试验目录（默认 /tmp/dsh-offline-repro；会被清空重建）
  --evidence <file>        把结论追加到该文件
  -h, --help               显示本帮助

退出码: 0=全过（含反证）  1=用法/环境错误  2=有判据不过
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --pnpm-bin)       PNPM_BIN="${2:-}"; shift 2 ;;
    --profile-source) PROFILE_SOURCE="${2%/}"; shift 2 ;;
    --scratch)        SCRATCH="${2%/}"; shift 2 ;;
    --evidence)       EVIDENCE="${2:-}"; shift 2 ;;
    -h|--help)        usage; exit 0 ;;
    *) err "未知参数：$1"; usage >&2; exit 1 ;;
  esac
done

if [[ -z "$PNPM_BIN" ]]; then PNPM_BIN="$(npm prefix -g)/bin/pnpm"; fi
[[ -x "$PNPM_BIN" ]] || { err "pnpm 不存在或不可执行：$PNPM_BIN（本机全局那份实测会 SIGSEGV，建议 --pnpm-bin \$HOME/pnpm1251/bin/pnpm）"; exit 1; }
PNPM_VER="$("$PNPM_BIN" --version 2>/dev/null || true)"
[[ -n "$PNPM_VER" ]] || { err "$PNPM_BIN --version 失败"; exit 1; }

FAILS=()
pass() { printf '  %-5s PASS  %s\n' "$1" "$2"; }
fail() { printf '  %-5s FAIL  %s\n' "$1" "$2"; FAILS+=("$1"); }

# 顺序无关的产物清单：排序后的「类型 相对路径」列表
manifest() {
  ( cd "$1" && find . -mindepth 1 \( -type f -o -type l \) -printf '%y %p\n' 2>/dev/null | sort )
}

rm -rf "$SCRATCH"; mkdir -p "$SCRATCH"
if [[ -n "$PROFILE_SOURCE" ]]; then
  [[ -f "$PROFILE_SOURCE/package.json" ]] || { err "缺 $PROFILE_SOURCE/package.json"; exit 1; }
  cp "$PROFILE_SOURCE/package.json" "$SCRATCH/package.json"
  [[ -f "$PROFILE_SOURCE/pnpm-lock.yaml" ]] && cp "$PROFILE_SOURCE/pnpm-lock.yaml" "$SCRATCH/pnpm-lock.yaml"
else
  cp "$PROFILE_TEMPLATE_DEFAULT" "$SCRATCH/package.json"
  [[ -f "$LOCKFILE_DEFAULT" ]] && cp "$LOCKFILE_DEFAULT" "$SCRATCH/pnpm-lock.yaml"
fi

log "pnpm = $PNPM_BIN（$PNPM_VER）· 试验目录 = $SCRATCH"
log "store = $("$PNPM_BIN" store path 2>/dev/null || echo '<未知>')"
LOCK_HAS=0; [[ -f "$SCRATCH/pnpm-lock.yaml" ]] && LOCK_HAS=1
log "lockfile = $([[ "$LOCK_HAS" == "1" ]] && echo 有 || echo '**无**（O-2 的 --frozen-lockfile 将无钉点）')"

# ---------------------------------------------------------------- O-1 联网预热
log "O-1 联网安装（预热 store）…"
t0=$(date +%s)
( cd "$SCRATCH" && "$PNPM_BIN" install --ignore-scripts --registry="$NPM_MIRROR" ) >"$SCRATCH/o1.log" 2>&1
rc1=$?
t1=$(date +%s)
if [[ "$rc1" -eq 0 ]]; then
  pass O-1 "联网安装 rc=0（$((t1 - t0)) s）"
else
  fail O-1 "联网安装 rc=$rc1（见 $SCRATCH/o1.log 末 20 行：$(tail -20 "$SCRATCH/o1.log" | tr '\n' ' ' | head -c 400)）"
fi
O1_ENTRIES="$(find "$SCRATCH/node_modules/.pnpm" -mindepth 1 -maxdepth 1 -not -name '.*' 2>/dev/null | wc -l)"
O1_SIZE="$(du -sh "$SCRATCH/node_modules" 2>/dev/null | awk '{print $1}')"
manifest "$SCRATCH/node_modules" > "$SCRATCH/manifest.online.txt" 2>/dev/null || true
LOCK_SUM_BEFORE="$(sha256sum "$SCRATCH/pnpm-lock.yaml" 2>/dev/null | awk '{print $1}')"
log "  ⇒ .pnpm $O1_ENTRIES 条 · node_modules $O1_SIZE"

# ---------------------------------------------------------------- O-2 离线复现
if [[ "$LOCK_HAS" != "1" ]]; then
  fail O-2 "没有 pnpm-lock.yaml ⇒ 无法 --frozen-lockfile（先跑一次联网生成，或用 --profile-source 指到 release 的 profile）"
else
  log "O-2 删掉 node_modules 后 --frozen-lockfile --offline …"
  rm -rf "$SCRATCH/node_modules"
  t2=$(date +%s)
  ( cd "$SCRATCH" && "$PNPM_BIN" install --frozen-lockfile --offline --ignore-scripts ) >"$SCRATCH/o2.log" 2>&1
  rc2=$?
  t3=$(date +%s)
  if [[ "$rc2" -eq 0 ]]; then
    pass O-2 "--frozen-lockfile --offline rc=0（$((t3 - t2)) s）"
  else
    # 明确失败 = 可接受（**只要不是静默降级**）：打印原因，供人工判断
    fail O-2 "rc=$rc2 —— **明确失败**（可接受但需人工裁定）：$(grep -m1 -E 'ERR_PNPM|snapshot not present|offline' "$SCRATCH/o2.log" | head -c 300)"
  fi
  O2_ENTRIES="$(find "$SCRATCH/node_modules/.pnpm" -mindepth 1 -maxdepth 1 -not -name '.*' 2>/dev/null | wc -l)"
  manifest "$SCRATCH/node_modules" > "$SCRATCH/manifest.offline.txt" 2>/dev/null || true
  LOCK_SUM_AFTER="$(sha256sum "$SCRATCH/pnpm-lock.yaml" 2>/dev/null | awk '{print $1}')"

  # -------------------------------------------------------------- O-3 产物比对
  if [[ "$rc2" -eq 0 ]]; then
    if diff -q "$SCRATCH/manifest.online.txt" "$SCRATCH/manifest.offline.txt" >/dev/null 2>&1 \
       && [[ "$O1_ENTRIES" == "$O2_ENTRIES" ]] \
       && [[ "$LOCK_SUM_BEFORE" == "$LOCK_SUM_AFTER" ]]; then
      pass O-3 "离线产物与联网逐条一致（$O2_ENTRIES 条 · $O1_SIZE）且 lockfile 未被改动"
    else
      fail O-3 "产物不一致：条目 $O1_ENTRIES → $O2_ENTRIES；lockfile $([[ "$LOCK_SUM_BEFORE" == "$LOCK_SUM_AFTER" ]] && echo 未变 || echo **被改**)"
    fi
  else
    fail O-3 "O-2 未成功 ⇒ 无从比对（不是静默降级，属"明确失败"）"
  fi
fi

# ---------------------------------------------------------------- 反证：空 store + 离线必须失败
log "反证：空 store + --offline 必须**失败**（否则 --offline 没生效）"
EMPTY="$(mktemp -d)"
rm -rf "$SCRATCH/node_modules"
( cd "$SCRATCH" && "$PNPM_BIN" install --frozen-lockfile --offline --ignore-scripts --store-dir "$EMPTY" ) >"$SCRATCH/neg.log" 2>&1
rcN=$?
rm -rf "$EMPTY"
if [[ "$rcN" -ne 0 ]]; then
  pass "反证" "空 store + --offline **明确失败** rc=$rcN ⇒ --offline 真的生效（fail-closed 正确）"
else
  fail "反证" "空 store + --offline 居然 rc=0 ⇒ 🔴 --offline 未生效，O-2 的结论不可信"
fi

# ---------------------------------------------------------------- O-4 结论
echo
if [[ ${#FAILS[@]} -eq 0 ]]; then
  CONCLUSION="✅ 离线可复现**成立**（本机实测）：pnpm $PNPM_VER 在 store 预热后 \`--frozen-lockfile --offline\` rc=0、耗时 $((t3 - t2)) s、产物 $O2_ENTRIES 条 \`.pnpm\` / $O1_SIZE、lockfile 未被改动、与联网产物逐条一致；空 store 时明确失败 ⇒ \`--offline\` 生效。⚠️ 必须带 \`--ignore-scripts\`（pnpm 12 会因 node-pty 的 build script 报 ERR_PNPM_IGNORED_BUILDS 并 rc=1，而树其实已装好）。"
  log "O-4 结论：$CONCLUSION"
  if [[ -n "$EVIDENCE" ]]; then
    mkdir -p "$(dirname "$EVIDENCE")"
    printf '%s | %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$CONCLUSION" >> "$EVIDENCE"
    log "已追加到 $EVIDENCE"
  fi
  exit 0
fi
err "❌ 离线可复现未过：${FAILS[*]}"
exit 2
