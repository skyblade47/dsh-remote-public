#!/usr/bin/env bash
# release 所有权一次性迁移（release 所有权迁移设计 §7/§8）。
#
# 🔴 默认 --dry-run：**只打印将要执行的全部动作，不做任何修改**。--apply 才动手。
# 🔴 本脚本**只入仓，不在本计划里执行**：真机那一次留给"第一次真升级"。
#
# 顺序铁律（设计 §7）：先放目录 ⇒ 再核对 ⇒ 再迁移 ⇒ 再翻链 ⇒ 再重启 ⇒ 再验。
#   绝不"先重启再翻链"（那是"新内核进程配旧插件解析"的最坏组合）。
#
# 硬约束（设计 §2.1）：
#   约束 1：`@local/*` 必须与 `<release>/plugins/*` **逐条一一对应**（多/少都让 boot 崩）。
#           ⇒ 生成与删除**都遍历目录**，脚本里**不出现任何插件名清单**。
#   约束 2：`version-radar` 必须**提前补进 release**（2026-09-26 实测：`@local/` 13 条
#           vs `<release>/plugins/` 12 个 ⇒ 直接迁移就是断链）。⇒ 3a 按**差集**补，不写死名字。
set -euo pipefail

RELEASE_ROOT="${DSH_RELEASE_ROOT:-/usr/local/dsh-release}"
DSH_HOME="${DSH_HOME:-/srv/dsh-home}"
SERVICE_USER="${DSH_SERVICE_USER:-dsh}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PLUGIN_SRC="$REPO_ROOT/plugins"
KERNEL_UNIT="${DSH_KERNEL_UNIT:-dsh-kernel}"
RESTART_KERNEL="$REPO_ROOT/deploy/linux/restart-kernel.sh"
KR="$REPO_ROOT/deploy/linux/kernel-release.sh"

VER=''
DRY_RUN=1
ACCEPT_DATA_RISK=0

log(){  printf '[migrate] %s\n' "$*"; }
warn(){ printf '[migrate] ⚠️  %s\n' "$*" >&2; }
die(){  printf '[migrate] 🔴 %s\n' "$*" >&2; exit 1; }
# 所有会改机器的动作都必须经 run()：dry-run 只打印，apply 才执行。
run(){ if (( DRY_RUN )); then printf '[dry-run] %s\n' "$*"; else log "+ $*"; "$@"; fi; }

usage(){ cat <<'EOF'
用法：release-ownership-migrate.sh --version <ver> [--apply] [--accept-data-risk]
                                    [--release-root <dir>] [--dsh-home <dir>]

默认 = --dry-run：只打印将要执行的全部动作，**不做任何修改**。
--apply             真的执行（需要 root）。
--accept-data-risk  与 --apply 连用：显式确认"已读过设计 §8 的回滚口径"（迁移会改变解析目标）。
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --version)          VER="${2:-}"; shift 2 ;;
    --apply)            DRY_RUN=0; shift ;;
    --accept-data-risk) ACCEPT_DATA_RISK=1; shift ;;
    --release-root)     RELEASE_ROOT="${2:-}"; shift 2 ;;
    --dsh-home)         DSH_HOME="${2:-}"; shift 2 ;;
    -h|--help)          usage; exit 0 ;;
    *) die "未知参数：$1" ;;
  esac
done
[[ -n "$VER" ]] || { usage; die "--version 必填"; }
[[ "$VER" != */* ]] || die "<ver> 不能含 /"
TARGET="$RELEASE_ROOT/$VER"

# ---------------------------------------------------------------- 0) 门闸
step0_gate() {
  [[ -f "$RESTART_KERNEL" ]] || die "找不到 $RESTART_KERNEL"
  log "0) 门闸：restart-kernel.sh --check（exit 0 才继续；2 = 有在飞不切；3 = 取不到判定 fail-closed）"
  log "   命令：bash $RESTART_KERNEL --check"
  if (( DRY_RUN )); then
    printf '[dry-run] bash %s --check\n' "$RESTART_KERNEL"
    return 0
  fi
  local rc=0
  bash "$RESTART_KERNEL" --check || rc=$?
  (( rc == 0 )) || die "门闸不通过（exit=$rc）：2 = 有在飞的工作，稍后再来；3 = 取不到判定（fail-closed，不许硬闯）"
  log "   ✓ 门闸通过（openTurns/delegations 均为 0）"
}

# ---------------------------------------------------------------- 1) 先放
step1_place() {
  log "1) 【先放】release 目录就位 + 落 release.json + 权限自检"
  [[ -d "$TARGET" ]] || die "1：$TARGET 不存在（先把新 release 装配好：bash $KR install $VER …）"
  [[ -f "$TARGET/release.json" ]] || die "1：$TARGET/release.json 不存在（契约见整包式设计 §②-10）"
  [[ -d "$TARGET/plugins" ]] || die "1：$TARGET/plugins 不存在"
  [[ -d "$TARGET/profile/node_modules" ]] \
    || warn "1：$TARGET/profile/node_modules 不存在 ⇒ 3c 的 P-A 无法做（P-A 要求 release 里带完整的 367 MiB 树）"
  # ⚠️ 本步**不做**权限加固：3b 还要往 release 侧 profile/node_modules/@local/ 写链接、
  #    3c 还要把第三方树接进 release ⇒ 先加固（只读）这两步就 EACCES。加固挪到 3d（在 3b/3c 之后）。
  log "   权限加固（chown root:root + chmod -R u=rwX,go=rX）**不在此步** ⇒ 见 3d（必须排在 3b/3c 之后）"
  log "   自检：sudo -u $SERVICE_USER test -r $TARGET/kernel/lib/node_modules/@deepseek-ai/dsh/package.json"
  if (( DRY_RUN )); then
    printf '[dry-run] sudo -u %s test -r %s\n' "$SERVICE_USER" "$TARGET/kernel/lib/node_modules/@deepseek-ai/dsh/package.json"
  else
    runuser -u "$SERVICE_USER" -- test -r "$TARGET/kernel/lib/node_modules/@deepseek-ai/dsh/package.json" \
      || die "1：服务用户读不到内核入口（权限不对 ⇒ 后面必崩）"
    log "   ✓ 权限自检通过"
  fi
}

# ---------------------------------------------------------------- 2) 再核对
step2_verify_manifest() {
  log "2) 【核对】release.json 的 pluginSet / pluginSha256 / thirdParty[] 与盘上逐项一致"
  log "   🔴 且 <release>/plugins/* 与 @local/* 的**预期集**一致（约束 1）"
  # 🔴 缺陷 4（必须排除 node_modules）：F1 宿主包接线会在 <release>/plugins/ 下建出
  #    plugins/node_modules/@deepseek-ai/dsh-tools（kernel-release.sh install 的 4b 步）。
  #    它是**依赖接线、不是插件**；若把它计入"目录数"，这里就会 13 vs 14 ⇒ 误判不一致并 die。
  #    口径与 kernel-release.sh 的 plugins_json（state.json 的 pluginSet 必须恰好是插件集合）一致。
  local n
  n="$(find "$TARGET/plugins" -mindepth 1 -maxdepth 1 -type d ! -name node_modules | wc -l)"
  log "   release/plugins 目录数 = $n（已排除 node_modules）"
  RL="$TARGET" RJ="$TARGET/release.json" node -e '
    const fs = require("fs"); const path = require("path")
    const rj = JSON.parse(fs.readFileSync(process.env.RJ, "utf8"))
    const onDisk = fs.readdirSync(path.join(process.env.RL, "plugins"), { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name !== "node_modules").map((e) => e.name).sort()
    const declared = [...(rj.pluginSet || [])].sort()
    const same = JSON.stringify(onDisk) === JSON.stringify(declared)
    console.log(`[migrate]   pluginSet 声明 ${declared.length} 条 / 盘上 ${onDisk.length} 条 ⇒ ${same ? "一致 ✓" : "不一致 ✗"}`)
    if (!same) { console.error(`[migrate]   盘上 = ${onDisk.join(",")}\n[migrate]   声明 = ${declared.join(",")}`); process.exit(1) }
  ' || die "2：release.json.pluginSet 与盘上不一致（先修 release 装配，再迁移）"
  log "   命令：bash $KR verify --window 150（切完之后才跑）"
}

# ---------------------------------------------------------------- 3a) 补齐差集（约束 2）
step3a_fill_plugins() {
  log "3a) 【补齐 release/plugins】遍历 $PLUGIN_SRC/* 求差集（**不写死插件名**）"
  log "   依据（整包式设计 §②-7(a) + 约束 2）：2026-09-26 实测差集 = [version-radar]"
  log "   （@local/ 13 条 vs <release>/plugins/ 12 个 ⇒ 不补就是断链）"
  local added=() p name
  for p in "$PLUGIN_SRC"/*/; do
    name="$(basename "$p")"
    [[ "$name" == "node_modules" ]] && continue
    [[ -f "${p}package.json" ]] || continue
    [[ -d "$TARGET/plugins/$name" ]] && continue
    added+=("$name")
  done
  log "   本次要补进 release 的差集：${added[*]:-<空>}"
  if (( ${#added[@]} == 0 )); then
    log "   ✓ 无需补齐（release/plugins 已含仓库全部自研插件）"
  fi
  for name in ${added[@]+"${added[@]}"}; do
    [[ -n "$name" ]] || continue
    run rsync -a --delete "$PLUGIN_SRC/$name/" "$TARGET/plugins/$name/"
    run chown -R root:root "$TARGET/plugins/$name"
    run chmod -R u=rwX,go=rX "$TARGET/plugins/$name"
  done
  log "   更新 release.json 的 pluginSet/pluginSha256 与 state.json 的 pluginSet"
  # 🔴 缺陷 4（同口径）：下面的计数与 JS 重算都必须**排除 node_modules**（F1 接线的 plugins/node_modules），
  #    否则 pluginSet 会多出一个 "node_modules" 条目、且下次 step2 的"盘上 vs 声明"必然不一致。
  if (( DRY_RUN )); then
    printf '[dry-run] 重算 pluginSet/pluginSha256（%d 个目录，已排除 node_modules）并写回 %s 与 state.json\n' \
      "$(find "$TARGET/plugins" -mindepth 1 -maxdepth 1 -type d ! -name node_modules | wc -l)" "$TARGET/release.json"
    return 0
  fi
  REL="$TARGET/plugins" RJ="$TARGET/release.json" ST="$RELEASE_ROOT/state.json" node -e '
    const fs = require("fs"); const path = require("path"); const crypto = require("crypto")
    const root = process.env.REL
    const plugins = fs.readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name !== "node_modules").map((e) => e.name).sort()
    const sha = {}
    const walk = (d, rel) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name); const r = rel ? rel + "/" + e.name : e.name
        if (e.isDirectory()) walk(p, r)
        else if (e.isFile()) sha[r] = crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex")
      }
    }
    for (const n of plugins) walk(path.join(root, n), n)
    const rj = JSON.parse(fs.readFileSync(process.env.RJ, "utf8"))
    rj.pluginSet = plugins; rj.pluginSha256 = sha
    fs.writeFileSync(process.env.RJ, JSON.stringify(rj, null, 2) + "\n")
    const st = JSON.parse(fs.readFileSync(process.env.ST, "utf8"))
    st.pluginSet = plugins
    fs.writeFileSync(process.env.ST, JSON.stringify(st, null, 2) + "\n")
    console.log(`[migrate]   ✓ pluginSet=${plugins.length} 条，pluginSha256=${Object.keys(sha).length} 条`)
  ' || die "3a：写回 release.json/state.json 失败"
}

# ---------------------------------------------------------------- 3b) @local/* 双向对齐
step3b_relink_local() {
  # 🔴 本函数修了两处缺陷（任一处都会让"所有权收拢到 release"落空）：
  #   缺陷 1（作用对象/顺序）：原实现在 **DSH_HOME 侧的实体目录**
  #     $DSH_HOME/profiles/web/node_modules/@local 上改链接。而 3c(P-A) 紧接着把该**实体目录**
  #     mv 成 node_modules.pre-PA-<ts> 备份、再把 node_modules 软链到 release ⇒ 3b 改好的链接
  #     随实体目录一起被搬走；**生效的**是 release 侧那份 profile/node_modules/@local —— 它从没被
  #     3b 改过 ⇒ @local/* 仍指 /opt/dsh-remote/plugins/*，"收拢"落空。
  #     ⚠️ 也不能把 3b/3c 调换顺序：那样 @local/ 会穿过软链落在**已加固为只读**的 release 里、
  #        ln -sfn 会 EACCES。⇒ 正确做法：3b 直接作用在 **release 侧** dir，加固挪到 3b/3c 之后的 3d。
  #   缺陷 2（链接目标写死版本）：原实现 ln 的目标是 "${p%/}" = <release>/<ver>/plugins/<n>
  #     （**写死版本**）⇒ 之后翻 current 时这些链接不跟着走，"原子翻链"被破坏。
  #     ⇒ 目标改为 <release>/current/plugins/<n>（与设计 §7 3b 的口径一致）。
  # ⚠️ 遍历的仍是 **$TARGET/plugins**（不是 current/plugins）：首次迁移时 current 可能还不存在。
  #    但**目标**是 current ⇒ 之后切包只翻 current 一个链接（原子）。
  local src="$TARGET/plugins" dir="$TARGET/profile/node_modules/@local"
  log "3b) 【@local/* 双向对齐】遍历 $src/*（**不写死插件名**）"
  [[ -d "$src" ]] || die "3b：$src 不存在"
  # 前置 fail-closed：本步要把 @local/* 指到 current/plugins，没有 current 就建不出"翻链即生效"的链接。
  [[ -e "$RELEASE_ROOT/current" || -L "$RELEASE_ROOT/current" ]] \
    || die "3b：$RELEASE_ROOT/current 不存在 —— 本步要把 @local/* 指到 current/plugins，没有 current 就 fail-closed（先 install 或先翻链）"
  [[ -d "$dir" ]] || die "3b：$dir 不存在（release 的 profile/node_modules 未就位，先做 P-A 前置）"
  # 此刻 $dir 可能已被加固过（加固统一由 3d 做；本步写完仍交给 3d）⇒ 先确保可写，否则 ln/rm 会 EACCES。
  run chmod u+w "$dir"
  local p name
  for p in "$src"/*/; do
    name="$(basename "$p")"
    [[ "$name" == "node_modules" ]] && continue
    [[ -f "${p}package.json" ]] || continue
    run ln -sfn "$RELEASE_ROOT/current/plugins/$name" "$dir/$name"
    # 属主与 release 其余部分一致（root:root）。P-A 的"只读"保护靠"不逐条对齐就 EACCES"（由目录/文件
    # 权限强制）来成立，与**链接自身的属主**无关（穿过软链的写操作看的是链接目标、不是链接属主）。
    run chown -h root:root "$dir/$name"
  done
  # 反向：删掉 release 里已不存在的陈旧 @local/<x>（约束 1；多一条 ⇒ heal 想 unlink ⇒ EACCES 崩）
  # —— 与上面的生成作用在**同一个 release 侧 dir** 上。
  local l ln stale=0
  for l in "$dir"/*; do
    [[ -e "$l" || -L "$l" ]] || continue
    ln="$(basename "$l")"
    [[ -d "$src/$ln" ]] && continue
    warn "3b 删除多余链接 @local/$ln（$src 里已不存在）"
    stale=$((stale + 1))
    run rm -f "$l"
  done
  log "   生成 $(find "$src" -mindepth 1 -maxdepth 1 -type d ! -name node_modules | wc -l) 条 / 删除 $stale 条 ⇒ 与 release 逐条对齐"
  log "   链接目标 = $RELEASE_ROOT/current/plugins/<n> ⇒ 之后切包只翻 current 一个链接（原子）"
}

# ---------------------------------------------------------------- 3c) P-A
step3c_pa() {
  local pnm="$DSH_HOME/profiles/web/node_modules"
  local rel_pnm="$RELEASE_ROOT/current/profile/node_modules"
  log "3c) 【P-A】把 $pnm 改成软链 → $rel_pnm"
  if [[ -L "$pnm" ]]; then log "   ○ 已经是软链 ⇒ 跳过（幂等）"; return 0; fi
  [[ -d "$RELEASE_ROOT/$VER/profile/node_modules" ]] \
    || die "3c：$RELEASE_ROOT/$VER/profile/node_modules 不存在 —— P-A 要求 release 里带完整树（先把它放进去）"
  local bak="$DSH_HOME/profiles/web/node_modules.pre-PA-$(date +%Y%m%d-%H%M%S)"
  run mv "$pnm" "$bak"
  run ln -s "$rel_pnm" "$pnm"
  log "   旧实体目录留在 $bak（未删；确认稳定后再人工清理）"
}

# ---------------------------------------------------------------- 3d) 加固
# ⚠️ 为什么加固**必须排在 3b/3c 之后**：
#   3b 要往 release 侧 profile/node_modules/@local/ 写/删链接；3c 要把第三方树（profile/node_modules）
#   接进 release。release 一旦 chmod -R u=rwX,go=rX（对服务用户只读）后，这些写入会 EACCES ⇒ **先写后加固**。
#   加固本身是 root 操作，排在哪都"能成功"，但排在 3b/3c 之前就会让 3b/3c 失败 ⇒ 顺序不可换。
step3d_harden() {
  log "3d) 【加固】$TARGET 只读收口：chown -R root:root + chmod -R u=rwX,go=rX"
  run chown -R root:root "$TARGET"
  run chmod -R u=rwX,go=rX "$TARGET"
  local entry="$TARGET/kernel/lib/node_modules/@deepseek-ai/dsh/package.json"
  log "   自检①：sudo -u $SERVICE_USER test -r $entry（加固后服务用户仍能读内核入口）"
  log "   自检②：sudo -u $SERVICE_USER find $TARGET -writable -print -quit（期望**空输出**）"
  if (( DRY_RUN )); then
    printf '[dry-run] test -r %s（以 %s 身份）\n' "$entry" "$SERVICE_USER"
    printf '[dry-run] find %s -writable -print -quit（以 %s 身份；期望空输出）\n' "$TARGET" "$SERVICE_USER"
    return 0
  fi
  runuser -u "$SERVICE_USER" -- test -r "$entry" \
    || die "3d：服务用户读不到内核入口（加固把可读性也弄坏了）"
  # ② 服务用户在整个 release 里**不应有任何可写项**（P-A 的"只读"前提）。非空 ⇒ fail-closed。
  local w='' rc=0
  w="$(runuser -u "$SERVICE_USER" -- find "$TARGET" -writable -print -quit)" || rc=$?
  (( rc == 0 )) || die "3d：自检②取不到判定（exit=$rc）⇒ fail-closed，不许当作通过"
  [[ -z "$w" ]] || die "3d：$TARGET 下仍有服务用户可写项：$w ⇒ P-A 的'只读'前提不成立"
  log "   ✓ 加固自检通过（可读 + 服务用户全程不可写）"
}

# ---------------------------------------------------------------- 4) 翻链
step4_flip() {
  log "4) 【翻链】ln -sfn $RELEASE_ROOT/$VER …/current.new && mv -Tf …/current.new …/current"
  run ln -sfn "$RELEASE_ROOT/$VER" "$RELEASE_ROOT/current.new"
  run mv -Tf "$RELEASE_ROOT/current.new" "$RELEASE_ROOT/current"
  log "   ★ 此刻起：内核 + 全部自研插件 +（P-A）第三方 同时指向新版（原子）"
  # 🔴 缺陷 3 + 缺陷 5：必须把 state.json 的 switchedAt 与 **current** 一起对齐到本次翻链。
  #   ① switchedAt：verify 的 --window 150 窗口按它算（cmd_verify 的 H2/H4）⇒ 不更新就把旧 OOM
  #      算进窗口 ⇒ H2 假红（实测陈旧为 2026-09-26T08:52:07Z）。
  #   ② current：verify 的 H5/A10 拿 `state.json.current` 当**期望值**去比 `readlink -f $PNM`
  #      ⇒ 不更新就报 "H5/A10 ✗ 指向 …/rc.X/profile/node_modules，期望 …/rc.Y/…"
  #      （2026-09-27 真机实测：整包切到 0.1.5-rc.3 后 A10 假红、而功能面全绿）。
  #      `kernel-release.sh switch` 本来就会写这个字段，本脚本不走 switch ⇒ 必须自己写；
  #      否则元数据与现实不一致（也会影响 rollback 的"翻回哪个版本"的判定）。
  #   两者一起读改写、保留其余字段（tmp+rename 原子替换，避免读者看到半个 JSON）。
  log "   已把 switchedAt 与 current 对齐到本次翻链：$RELEASE_ROOT/state.json"
  if (( DRY_RUN )); then
    printf '[dry-run] 更新 %s：switchedAt ← 当前 UTC ISO 时刻；current ← %s（保留其余字段）\n' \
      "$RELEASE_ROOT/state.json" "$VER"
  else
    ST="$RELEASE_ROOT/state.json" VER="$VER" node -e '
      const fs = require("fs")
      const f = process.env.ST
      const want = process.env.VER
      let s = {}
      try { s = JSON.parse(fs.readFileSync(f, "utf8")) } catch (e) {}
      const prev = s.current
      s.switchedAt = new Date().toISOString()
      s.current = want
      const tmp = f + ".tmp"
      fs.writeFileSync(tmp, JSON.stringify(s, null, 2) + "\n", { mode: 0o644 })
      fs.renameSync(tmp, f)
      console.log(`[migrate]   ✓ switchedAt=${s.switchedAt} / current=${prev} → ${s.current}`)
    ' || die "4：更新 state.json 的 switchedAt/current 失败"
    # 🔴 判据：元数据必须与现实一致（否则 verify 的 H5/A10 必假红）
    local cur_meta cur_real
    cur_meta="$(ST="$RELEASE_ROOT/state.json" node -e 'try{process.stdout.write(String(require(process.env.ST).current))}catch(e){process.stdout.write("")}' 2>/dev/null)"
    cur_real="$(basename "$(readlink -f "$RELEASE_ROOT/current")")"
    [[ "$cur_meta" == "$cur_real" ]] \
      || die "4：state.json.current='$cur_meta' 与现实 current='$cur_real' 不一致（verify 的 H5/A10 会假红）"
    log "   ✓ 元数据与现实一致：current=$cur_real"
  fi
}

# ---------------------------------------------------------------- 5) 重启
step5_restart() {
  log "5) 【重启】systemctl restart $KERNEL_UNIT"
  log "   （这是 restart-kernel.sh 之外的第二处重启入口 ⇒ 同一门闸口径，步骤 0 已过）"
  run systemctl restart "$KERNEL_UNIT"
}

# ---------------------------------------------------------------- 6) 验
step6_verify() {
  # 判据 6a（独立于 A9/A10 的**结构判据**）
  #   为什么单独立这条：A9/A10 **只看 boot 的 heal 行为**（journal 里有无 EACCES / node_modules 是否仍是软链），
  #   **看不出 @local/* 是否真的收拢到 release**。原实现恰好漏在这里：13 条 @local/* 仍指
  #   /opt/dsh-remote/plugins/*，而 A9/A10 **照样能过**（heal 发现条目已存在就直接 return ⇒ 零写入 ⇒ 无 EACCES）。
  #   ⇒ 必须另设一条结构判据：@local 下每条 readlink -f 的落点都必须落在 $TARGET/ 之内，
  #     且条目数与 $TARGET/plugins 下的目录数**逐条一一对应**（约束 1）。
  #   ⚠️ 这是"迁移后"的核对 ⇒ 只在 --apply 下真的执行（--dry-run 必须能跑通并只打印，设计 §5 交付物5 / §11 V2；
  #      且 dry-run 时盘上仍是迁移前形态：@local 指 /opt、3a 还没补 version-radar ⇒ 在 dry-run 里判必然误报）。
  log "6a) 【结构判据】@local/* 逐条落在 $TARGET/ 内，且与 $TARGET/plugins 一一对应（约束 1）"
  local ld="$TARGET/profile/node_modules/@local"
  if (( DRY_RUN )); then
    printf '[dry-run] 校验 %s 下每条 readlink -f 落在 %s/ 内；条目数须 == %s 下目录数（均排除 node_modules）\n' \
      "$ld" "$TARGET" "$TARGET/plugins"
    printf '[dry-run] 任一条越界或计数不等 ⇒ die（所有权未收拢）\n'
  else
    local n_plugs n_local l name tgt bad=0
    [[ -d "$ld" ]] || die "6a：$ld 不存在 ⇒ 3b/3c 没做完"
    n_plugs="$(find "$TARGET/plugins" -mindepth 1 -maxdepth 1 -type d ! -name node_modules | wc -l)"
    n_local="$(find "$ld" -mindepth 1 -maxdepth 1 ! -name node_modules | wc -l)"
    log "   @local 条目 = $n_local ／ <release>/plugins 目录 = $n_plugs"
    (( n_local == n_plugs )) \
      || die "6a：@local 条目数（$n_local）≠ <release>/plugins 目录数（$n_plugs）⇒ 违反约束 1（必须逐条一一对应）"
    for l in "$ld"/*; do
      [[ -e "$l" || -L "$l" ]] || continue
      name="$(basename "$l")"
      [[ "$name" == "node_modules" ]] && continue
      tgt="$(readlink -f "$l" 2>/dev/null)" || tgt=''
      [[ -n "$tgt" && "$tgt" == "$TARGET"/* ]] && continue
      bad=$((bad + 1))
      warn "6a 未收拢：@local/$name → ${tgt:-<断链>}"
    done
    (( bad == 0 )) || die "6a：$bad 条 @local/* 的所有权未收拢（本该指 $RELEASE_ROOT/current/plugins/<n>）"
    log "   ✓ 6a 通过：$n_local 条 @local/* 全部落在 $TARGET/ 内"
  fi
  log "6) 【验】等 T+150 s 后跑 A 栏（含 A9/A10）+ B 栏 + C 栏"
  log "   命令：bash $KR verify --window 150"
  log "   🔴 A9 + A10 任一不过 ⇒ 按'不通过'处理（走回滚），不许'接着用'"
  log "   回滚：翻回旧 current + bash $RESTART_KERNEL --force"
  log "        （新版起不来时门闸端点 /adapter/api/resume/gate 也在内核进程里 ⇒ 正常路径会 exit 3 拒绝重启）"
  log "   审计：把'谁 / 何时 / 切了哪个 $VER / A9+A10 结果'写进 $DSH_HOME/logs/"
  log "   ⚠️ 白名单不随包回：若出现多余条目（failed≠0 或新增 missing=[…]）用 hotplug API 改，别手改文件"
}

# ---------------------------------------------------------------- main
(( DRY_RUN )) && log "== DRY-RUN（默认）：下面全部只打印，不做任何修改 =="
(( DRY_RUN )) || { [[ "$(id -u)" == "0" ]] || die "--apply 需要 root"; (( ACCEPT_DATA_RISK )) || die "--apply 需同时给 --accept-data-risk（确认已读设计 §8 的回滚口径）"; }
log "release 根 = $RELEASE_ROOT · DSH_HOME = $DSH_HOME · 目标版本 = $VER"
step0_gate
step1_place
step2_verify_manifest
step3a_fill_plugins
step3b_relink_local
step3c_pa
step3d_harden
step4_flip
step5_restart
step6_verify
if (( DRY_RUN )); then
  log "== DRY-RUN 结束：以上动作**一条都没有执行**。真要动手请加 --apply --accept-data-risk =="
else
  log "== 迁移动作已下发。请立刻进入步骤 6 的验证窗口；不过就回滚（--force）。=="
fi
