#!/usr/bin/env bash
# 交付物 4：列出内核侧与部署侧**所有**会写 profiles/*/node_modules 的位置（S-1），
# 并逐条判定「受只读保护后的行为」（S-2）。⭐ 全程只读：不改任何文件、不连服务器。
#
# 🔴 为什么入仓且每次升级都要重跑：这份清单是"P-A 只读前提"的**唯一**依据；
#    heal 的实现一旦被上游改动（新增写入点 / 改短路语义），清单就必须跟着变 ——
#    本脚本对"清单外的写入点"**fail loud**，而不是静默忽略。
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$DIR/../../../.." && pwd)"
TOOLS_ROOT="${REL_OWN_TOOLS:-/tmp/rel-own-tools}"
AB="${REL_OWN_APP_BOOT_LIB:-$TOOLS_ROOT/app-boot/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js}"

fail=0
say(){ printf '%s\n' "$*"; }
hit(){ # hit <描述> <文件> <正则> <期望条数>
  local n
  n="$(grep -cE "$3" "$2" 2>/dev/null || true)"
  if [[ "$n" == "$4" ]]; then say "OK  $1（命中 $n）"; else say "NG  $1：期望 $4 条，实际 $n"; fail=1; fi
}

[[ -f "$AB" ]] || { echo "🔴 找不到 $AB —— 先跑 prepare-tools.sh" >&2; exit 1; }

say "===== S-1 内核侧（$AB）====="
hit "1 kernel +1: healProfilesModuleFallback 首句 mkdirSync(modulesDir) 打在软链上会短路" \
    "$AB" 'mkdirSync\(modulesDir, \{ recursive: true \}\)' 1
hit "2 kernel +1: healProfilesModuleFallbackLocked → ensureSymlink（写 profiles/node_modules，DSH_HOME 内）" \
    "$AB" 'ensureSymlink\(link, entry\.packageDir\)' 1
hit "3 kernel +2: ensureSymlink:422 / ensureModuleProxy:564 的 unlinkSync(link)（均在 DSH_HOME 内）" \
    "$AB" 'unlinkSync\(link\)' 2
hit "4 kernel +1: ensureSymlink 内 symlinkSync(target, link)" \
    "$AB" 'symlinkSync\(target, link, "junction"\)' 1
hit "5 kernel +1: healProfileModuleFallback 的 mkdirSync(profileModulesDir)（P-A 下 = 指向 release 的软链）" \
    "$AB" 'mkdirSync\(profileModulesDir, \{ recursive: true \}\)' 1
hit "6 kernel +1: healProfileModuleFallback 的 mkdirSync(ownedModulesDir)" \
    "$AB" 'mkdirSync\(ownedModulesDir, \{ recursive: true \}\)' 1
hit "7 kernel +1: removeProfileSymlink 内 unlinkSync(profileLink)（🔴 穿过软链打 release）" \
    "$AB" 'unlinkSync\(profileLink\)' 1
hit "8 kernel +1: removeProfileSymlink 内 unlinkSync(ownedLink)（DSH_HOME 内）" \
    "$AB" 'unlinkSync\(ownedLink\)' 1
hit "9 kernel +1: ensureProfileSymlink（发现条目已存在就直接 return ⇒ 条目级短路）" \
    "$AB" 'function ensureProfileSymlink' 1
hit "10 kernel +1: 锁文件是 <dir>.lock 兄弟 ⇒ 落在 DSH_HOME/profiles/node_modules.lock" \
    "$TOOLS_ROOT/app-boot/node_modules/@deepseek-ai/dsh-atomic-write/lib/index.js" 'const lockPath = `\$\{filename\}\.lock`;' 1

say "===== S-1 部署侧（我们的脚本）====="
hit "11 setup.sh: link_local_plugins() 会 rm -f + ln -s 到 profiles/web/node_modules/@local（🔴 穿过软链打 release）" \
    "$REPO_ROOT/deploy/linux/setup.sh" 'rm -f "\$dir/\$name"' 1
hit "12 setup.mjs: linkLocalDeps() 会 mkdir + 建链到 <profile>/node_modules/@local" \
    "$REPO_ROOT/server/scripts/setup.mjs" 'linkLocalDeps\(profileDir, profilePkg\)' 1
hit "13 setup.mjs: PLUGINS_DIR 可由 DSH_PLUGINS_DIR 覆盖（否则回落 REPO_ROOT/plugins）（H5/R2：link: 依赖的落点）" \
    "$REPO_ROOT/server/scripts/setup.mjs" "const PLUGINS_DIR = process\.env\.DSH_PLUGINS_DIR" 1
hit "14 profile-package.mjs: deriveDependencies() 由 bundles 推导 @local/* 的 link: 依赖" \
    "$REPO_ROOT/server/scripts/lib/profile-package.mjs" 'function deriveDependencies\(profileDir, pluginsDir, bundles\)' 1
hit "15 setup.mjs: linkHostPackages() 会写 <PLUGINS_DIR>/node_modules/@deepseek-ai" \
    "$REPO_ROOT/server/scripts/setup.mjs" "const scopeDst = path\.join\(PLUGINS_DIR, 'node_modules', '@deepseek-ai'\)" 1

say "===== 清单外写入点（fail loud）====="
extra="$(grep -nE 'mkdirSync|symlinkSync|unlinkSync|rmSync\(' "$AB" \
         | grep -E 'profileModulesDir|profileLink|ownedLink|ownedModulesDir|modulesDir' \
         | grep -vE 'mkdirSync\(modulesDir, \{ recursive: true \}\)|ensureSymlink\(link, entry\.packageDir\)|unlinkSync\(link\)|symlinkSync\(target, link, "junction"\)|mkdirSync\(profileModulesDir, \{ recursive: true \}\)|mkdirSync\(ownedModulesDir, \{ recursive: true \}\)|unlinkSync\(profileLink\)|unlinkSync\(ownedLink\)|mkdirSync\(dirname\(ownedLink\), \{ recursive: true \}\)|mkdirSync\(dirname\(profileLink\), \{ recursive: true \}\)' || true)"
if [[ -z "$extra" ]]; then
  say "OK  未发现清单外的 fallback 写入点"
else
  say "🔴 发现清单外的写入点（必须人工裁定是'抛错'还是'静默 catch'，并登记）："
  printf '%s\n' "$extra"
  fail=1
fi

say ""
say "===== S-2 逐条判定（受只读保护后的行为）====="
say "| # | 位置 | 函数 | 操作 | 落点 | 只读保护后的行为 | 判定 |"
say "|---|---|---|---|---|---|---|"
say "| 1 | dsh-app-boot/lib/index.js:660 | healProfilesModuleFallback | mkdir | DSH_HOME/profiles/node_modules | 打在'指向目录的软链'上短路（不抛、不替换） | ✅ 可接受（且该路径不由 P-A 改） |"
say "| 2 | dsh-app-boot/lib/index.js:669-676 | healProfilesModuleFallbackLocked | symlink/unlink | DSH_HOME/profiles/node_modules/<pkg> | 目标在 DSH_HOME，可写；正常写入 | ✅ 可接受（A9 收紧口径据此） |"
say "| 3 | dsh-app-boot/lib/index.js:715 | healProfileModuleFallback | mkdir | profiles/<name>/node_modules | P-A 下是软链 ⇒ 短路（B-1 实测） | ✅ 可接受 |"
say "| 4 | dsh-app-boot/lib/index.js:716 | healProfileModuleFallback | mkdir | profiles/<name>/.dsh-module-fallback/node_modules | DSH_HOME 内，可写 | ✅ 可接受 |"
say "| 5 | dsh-app-boot/lib/index.js:472 | removeProfileSymlink | unlink | profiles/<name>/node_modules/<pkg> | 🔴 **穿过软链打到 release** ⇒ \`EACCES\` ⇒ **非 ENOENT 一律 throw** | ✅ 可接受（= 崩，可观测；B-4 实测复现） |"
say "| 6 | dsh-app-boot/lib/index.js:450+407-426 | ensureProfileSymlink→ensureSymlink | symlink | profiles/<name>/node_modules/<pkg> | 🔴 **穿过软链打到 release** ⇒ \`EACCES\` ⇒ **throw** | ✅ 可接受（= 崩，可观测；B-3 实测复现） |"
say "| 7 | dsh-app-boot/lib/index.js:407-419 | ensureSymlink | throw | 条目存在但**不是**软链 | \`throw \"… exists and is not a symlink or dsh-managed module proxy\"\` | ✅ 可接受（= 崩；A9 正则里就含此串） |"
say "| 8 | dsh-atomic-write/lib/index.js:73 | withFileLock | 写锁文件 | DSH_HOME/profiles/node_modules.lock | DSH_HOME 内，可写 | ✅ 可接受 |"
say "| 9 | deploy/linux/setup.sh:515-539 | link_local_plugins | rm -f + ln -s | profiles/web/node_modules/@local/<n> | 🔴 **以 root 跑 ⇒ 穿过软链把链接写进 release**（不是 EACCES，是**污染快照**） | 🔴 **危险（静默）** ⇒ Task 7 处理 |"
say "| 10 | server/scripts/setup.mjs:185-197 | linkLocalDeps | mkdir + symlink | <profile>/node_modules/@local/<n> | 条目已存在即返回 \`exists\`（幂等），**不会**写；但 \`link:\` 依赖会被 \`pnpm install\` 重建 | 🔴 **危险（静默）** ⇒ Task 8 处理 |"
say "| 11 | server/scripts/setup.mjs:100-112 | linkHostPackages | mkdir + symlink | <PLUGINS_DIR>/node_modules/@deepseek-ai | 若 \`PLUGINS_DIR\` 改指只读 release ⇒ \`EACCES\` | ✅ 可接受（改指后必崩、可观测）⇒ Task 8 显式处理 |"
say "| 12 | dsh-app-boot/lib/index.js:733 | healProfileModuleFallback | mkdir | profiles/<name>/.dsh-module-fallback/node_modules[/@scope] | DSH_HOME 内，可写（\`mkdirSync(dirname(ownedLink))\`） | ✅ 可接受（登记；原计划清单未列） |"
say "| 13 | dsh-app-boot/lib/index.js:736 | healProfileModuleFallback | mkdir | profiles/<name>/node_modules[/@scope] | 无 scope ⇒ 打在软链上短路；带 scope（\`@scope/…\`）⇒ **穿过软链在 release 里 mkdir** ⇒ 只读时 \`EACCES\` ⇒ 崩（可观测） | ✅ 可接受（= 崩，可观测；登记；原计划清单未列） |"

say ""
say "===== S-3 回写提示 ====="
say "把上面的 S-1 清单 + S-2 判定表回写整包式设计 §A.3 #12（当前标 '❓ 未验'）⇒ 见 Task 11。"

echo
if (( fail == 0 )); then echo "✅ 扫描通过（S-1/S-2）"; exit 0; fi
echo "🔴 扫描未通过（出现清单外写入点或命中数不符）" >&2
exit 1
