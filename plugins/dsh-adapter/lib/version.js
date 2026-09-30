// @local/dsh-adapter —— 宿主版本/安装根探测（2026-09-17 新增：版本感知兼容）
// 目的：让 adapter 能在「当前宿主」与「未来升级后的宿主」上都给出正确的兼容判断，
//       而不是把版本号硬编码在代码里。全部为只读探测，零副作用。
//
// 探测顺序（先精确后兜底）：
//   1) 显式覆盖：config.compat.hostVersion
//   2) 环境变量：DSH_VERSION
//   3) 宿主入口 argv[1]（形如 <install>/node_modules/@deepseek-ai/dsh/lib/bin.js）→ 读同目录 package.json
//   4) 从本模块位置向上逐级找 node_modules/@deepseek-ai/dsh/package.json
//   5) 从 cwd 向上逐级找（同上）
// 每一步都记录来源（source），便于诊断"为什么判定成这个版本"。

import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HOST_PKG_REL = join('node_modules', '@deepseek-ai', 'dsh', 'package.json')

function readJsonSafe(p) {
  try {
    if (!existsSync(p)) return null
    return JSON.parse(readFileSync(p, 'utf8'))
  } catch (e) { return null }
}

function ancestors(start) {
  const out = []
  let cur = resolve(start)
  for (;;) {
    out.push(cur)
    const up = dirname(cur)
    if (up === cur || !up) break
    cur = up
  }
  return out
}

/** 读某个 @deepseek-ai/dsh 安装目录的版本 */
function versionFromPkgJson(p) {
  const j = readJsonSafe(p)
  return j && typeof j.version === 'string' ? j.version : null
}

/**
 * 探测宿主版本与安装位置。
 * @param {{ hostVersion?: string, installRootHint?: string }} [opts]
 * @returns {{ version: string, source: string, dshPkgPath: string|null, installRoot: string|null }}
 */
export function detectHost(opts) {
  const o = opts || {}
  // 1) 显式覆盖（配置优先，便于测试与人工纠正）
  if (o.hostVersion && String(o.hostVersion).trim()) {
    return { version: String(o.hostVersion).trim(), source: 'config.compat.hostVersion', dshPkgPath: null, installRoot: null }
  }
  // 2) 环境变量
  const envV = (process.env && process.env.DSH_VERSION) || ''
  if (envV.trim()) {
    return { version: envV.trim(), source: 'env.DSH_VERSION', dshPkgPath: null, installRoot: null }
  }
  // 3) 宿主入口 argv[1]：<install>/node_modules/@deepseek-ai/dsh/lib/bin.js
  const argv1 = (process.argv && process.argv[1]) || ''
  if (argv1 && /[\\/]@deepseek-ai[\\/]dsh[\\/]/.test(argv1)) {
    for (const dir of ancestors(dirname(argv1))) {
      const p = join(dir, 'package.json')
      const j = readJsonSafe(p)
      if (j && j.name === '@deepseek-ai/dsh' && typeof j.version === 'string') {
        return { version: j.version, source: 'argv[1]', dshPkgPath: p, installRoot: dirname(dir) }
      }
    }
  }
  // 3b) 宿主入口 argv[1] 的**上级目录布局**（2026-09-26 新增；纯追加，③ 的语义不变）：
  //     argv[1] 的形态不是 ③ 那种"路径里直接含 @deepseek-ai/dsh/"时（实测服务器上它是
  //     /usr/local/dsh-release/current/kernel/bin/dsh —— 一个 **bin 软链**，路径里没有包名），
  //     改按"从 argv[1] 所在目录向上逐级找 <dir>/lib/node_modules/@deepseek-ai/dsh/package.json"识别宿主安装根。
  //     ✅ 一条规则同时覆盖两种布局（实测两种都在盘上）：
  //        · release 布局：<release>/kernel/bin/dsh
  //            ⇒ 在 <dir> = <release>/kernel 命中
  //              <release>/kernel/lib/node_modules/@deepseek-ai/dsh/package.json
  //        · 旧 npm -g 布局：<prefix>/bin/dsh
  //            ⇒ 在 <dir> = <prefix> 命中 <prefix>/lib/node_modules/@deepseek-ai/dsh/package.json
  //            （实测 /usr/local/node-v22.19.0-linux-x64/bin/dsh 就是这一形态）
  //     installRoot 取 <dir>/lib/node_modules（与 4)/5)/6) 的"含 @deepseek-ai/dsh 的那个 node_modules"同义）；
  //     ⚠️ semver 的兜底命中**不靠 installRoot**，而靠 dshPkgPath 的同级候选：
  //        <dirname(dshPkgPath)>/node_modules/semver/index.js
  //        = <dir>/lib/node_modules/@deepseek-ai/dsh/node_modules/semver/index.js（服务器实测存在）
  //        —— 见 plugins/version-radar/lib/probe.js 的 resolveSemver()（两个 base × 两个候选，逐个试、失败继续）
  const argv1Dir = argv1 ? dirname(argv1) : ''
  if (argv1Dir) {
    for (const dir of ancestors(argv1Dir)) {
      const p = join(dir, 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
      const j = readJsonSafe(p)
      if (j && j.name === '@deepseek-ai/dsh' && typeof j.version === 'string') {
        return { version: j.version, source: 'argv[1]-lib', dshPkgPath: p, installRoot: join(dir, 'lib', 'node_modules') }
      }
    }
  }
  // 4) 从本模块位置向上找
  try {
    const here = dirname(fileURLToPath(import.meta.url))
    for (const dir of ancestors(here)) {
      const p = join(dir, HOST_PKG_REL)
      const v = versionFromPkgJson(p)
      if (v) return { version: v, source: 'module-path', dshPkgPath: p, installRoot: join(dir, 'node_modules') }
    }
  } catch (e) { /* 继续兜底 */ }
  // 5) 从 cwd 向上找
  try {
    for (const dir of ancestors(process.cwd())) {
      const p = join(dir, HOST_PKG_REL)
      const v = versionFromPkgJson(p)
      if (v) return { version: v, source: 'cwd', dshPkgPath: p, installRoot: join(dir, 'node_modules') }
    }
  } catch (e) { /* 忽略 */ }
  // 6) portable 布局兜底（脱离宿主进程时也能判定，例如自检/离线诊断）：
  //    <portable>/resources/<任意>/node_modules/@deepseek-ai/dsh/package.json
  //    portable 根 = DSH_HOME 的父目录（本机为 E:\DeepSeek-Harness-1.0.0-portable）
  try {
    const home = detectDshHome({ dshHome: o.dshHome })
    const bases = []
    if (home.path) bases.push(dirname(home.path))
    for (const dir of ancestors(process.cwd()).slice(0, 3)) bases.push(dir)
    for (const base of bases) {
      const resDir = join(base, 'resources')
      if (!existsSync(resDir)) continue
      for (const name of readdirSync(resDir)) {
        const p = join(resDir, name, HOST_PKG_REL)
        const v = versionFromPkgJson(p)
        if (v) return { version: v, source: 'portable-layout:' + name, dshPkgPath: p, installRoot: join(resDir, name, 'node_modules') }
      }
    }
  } catch (e) { /* 忽略 */ }
  return { version: 'unknown', source: 'none', dshPkgPath: null, installRoot: null }
}

/**
 * 定位 DSH_HOME（用于读取 profile 已装插件版本）。只读、多候选、返回来源。
 * @param {{ dshHome?: string, installRootHint?: string }} [opts]
 */
export function detectDshHome(opts) {
  const o = opts || {}
  if (o.dshHome && String(o.dshHome).trim()) return { path: resolve(String(o.dshHome).trim()), source: 'config' }
  const envH = (process.env && process.env.DSH_HOME) || ''
  if (envH.trim()) return { path: resolve(envH.trim()), source: 'env.DSH_HOME' }
  // 从 argv[1] 推断：<portable>/resources/dsh-runtime/node_modules/@deepseek-ai/dsh/lib/bin.js
  const argv1 = (process.argv && process.argv[1]) || ''
  const candidates = []
  if (argv1) {
    for (const dir of ancestors(dirname(argv1))) {
      candidates.push(join(dir, 'dsh-data'))
      candidates.push(join(dir, '..', 'dsh-data'))
      candidates.push(join(dir, '..', '..', 'dsh-data'))
    }
  }
  candidates.push(join(process.cwd(), 'dsh-data'))
  for (const c of candidates) {
    try {
      const norm = resolve(c)
      if (existsSync(norm)) return { path: norm, source: 'argv-inferred' }
    } catch (e) { /* 继续 */ }
  }
  return { path: null, source: 'none' }
}

/** 读取某个 profile 目录下已安装插件的版本（只读） */
export function installedPluginVersion(profileRoot, pkgName) {
  if (!profileRoot || !pkgName) return null
  const p = join(profileRoot, 'node_modules', ...pkgName.split('/'), 'package.json')
  const j = readJsonSafe(p)
  return j && typeof j.version === 'string' ? j.version : null
}
