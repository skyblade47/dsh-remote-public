// 上线前兼容性求交检查器（2026-09-23）
//
// 回答一个问题：**在我们要部署的那个 DSH 宿主版本上，每个插件各自「声明支持」的最高版本是哪个？
// 有没有谁在声明上就不支持？**
//
// 为什么要做成脚本而不是一次人工核对：上游发版很勤（实测：仅隔一天，宿主的传递依赖就从 rc.2
// 漂到 rc.3），而这份结论是"部署前必须重新成立"的东西。做成脚本 ⇒ 每次上线前跑一遍即可。
//
// 三个输入：
//   1) 宿主目标版本 —— 直接从 deploy/linux/setup.sh 的 DSH_VERSION 读（避免"文档写的"和"脚本干的"不一致）
//   2) 12 个自研插件 —— 读仓库 plugins/*/package.json 的 engines.dsh
//   3) 4 个第三方插件 —— 实查 npm registry：取最近 N 个版本，看各自声明的
//      `@deepseek-ai/dsh*` peer 范围是否包含目标宿主（用 adapter 自己的 satisfiesEngine 判定，
//      口径与运行期完全一致 —— 不另写一套，否则两边会漂）
//
// 用法：
//   node plugins/dsh-adapter/tools/compat-intersect.mjs              # 目标宿主取 setup.sh 里的值
//   node plugins/dsh-adapter/tools/compat-intersect.mjs 0.1.5-rc.2   # 指定宿主
//   node plugins/dsh-adapter/tools/compat-intersect.mjs --offline    # 不查网，只用本地声明
//
// 退出码：0 = 所有插件都在声明上支持该宿主；1 = 有插件在声明上不支持（需人工判定或换宿主）
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { satisfiesEngine } from '../lib/compat.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..', '..', '..')
const SETUP_SH = path.join(REPO, 'deploy', 'linux', 'setup.sh')
const KERNEL_PKG = '@deepseek-ai/dsh'
const THIRD_PARTY = [
  '@nanmicoder/dsh-agent-teams',
  '@huanlin/dsh-plugin-better-locale',
  'dsh-better-sidebar',
  'dshmarket',
]
const SCAN_VERSIONS = 24   // 每个第三方插件往回扫多少个版本

const args = process.argv.slice(2)
const OFFLINE = args.includes('--offline')
const argHost = args.find((a) => !a.startsWith('--'))

function readPinnedHost() {
  try {
    const txt = fs.readFileSync(SETUP_SH, 'utf8')
    const m = txt.match(/^\s*DSH_VERSION="([^"]+)"/m)
    return m ? m[1] : null
  } catch { return null }
}

function readLocalPlugins() {
  const dir = path.join(REPO, 'plugins')
  const out = []
  for (const n of fs.readdirSync(dir).sort()) {
    const f = path.join(dir, n, 'package.json')
    if (!fs.existsSync(f)) continue
    let pkg
    try { pkg = JSON.parse(fs.readFileSync(f, 'utf8')) } catch { continue }
    if (!pkg.dsh) continue
    out.push({ name: pkg.name, declared: (pkg.engines && pkg.engines.dsh) || null })
  }
  return out
}

function npmView(spec, field) {
  try {
    const out = execFileSync('npm', ['view', spec, field, '--json', '--registry=https://registry.npmjs.org'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 60000,
    })
    return JSON.parse(out)
  } catch { return null }
}

/** 该版本的「宿主相关」peer 范围（只看 @deepseek-ai/dsh*，cordis/schemastery 等与宿主版本无关） */
function hostRangesOf(peerDeps) {
  if (!peerDeps || typeof peerDeps !== 'object') return null
  const ranges = {}
  for (const [k, v] of Object.entries(peerDeps)) {
    if (/^@deepseek-ai\/dsh/.test(k)) ranges[k] = v
  }
  return Object.keys(ranges).length ? ranges : null
}

/** 某版本是否声明支持该宿主：所有 dsh* peer 范围都必须包含它（任一不含即判不支持） */
function versionSupports(peerDeps, host) {
  const ranges = hostRangesOf(peerDeps)
  if (!ranges) return { ok: null, why: '无 @deepseek-ai/dsh* peer 声明 ⇒ 无法判定' }
  for (const [k, r] of Object.entries(ranges)) {
    if (satisfiesEngine(r, host) !== true) return { ok: false, why: `${k} 声明 "${r}" 不含 ${host}` }
  }
  return { ok: true, why: `${Object.keys(ranges).length} 个 dsh* peer 声明均含 ${host}` }
}

function newestDeclaringVersion(pkg, host) {
  const versions = npmView(pkg, 'versions')
  if (!Array.isArray(versions)) return { error: '取不到版本列表（网络？可加 --offline）' }
  const recent = versions.slice(-SCAN_VERSIONS)
  for (let i = recent.length - 1; i >= 0; i--) {
    const v = recent[i]
    const peers = npmView(`${pkg}@${v}`, 'peerDependencies')
    const r = versionSupports(peers, host)
    if (r.ok === true) return { version: v, why: r.why, scanned: recent.length, latest: versions[versions.length - 1] }
  }
  return { version: null, scanned: recent.length, latest: versions[versions.length - 1] }
}

// ---------------- main ----------------
const host = argHost || readPinnedHost()
if (!host) {
  console.error('无法确定目标宿主版本：既没给参数，也没能从 deploy/linux/setup.sh 读到 DSH_VERSION')
  process.exit(2)
}

console.log('============================================================')
console.log('兼容性求交检查')
console.log('  目标宿主 : ' + host + (argHost ? '（命令行指定）' : '（读自 deploy/linux/setup.sh 的 DSH_VERSION）'))
console.log('  时间     : ' + new Date().toISOString())
console.log('  模式     : ' + (OFFLINE ? 'offline（不查网）' : '在线实查 npm registry'))
console.log('============================================================')

let hardFail = 0

console.log('\n【一】自研插件（12 个，读仓库 engines.dsh）')
const locals = readLocalPlugins()
let localOk = 0
for (const p of locals) {
  const r = p.declared ? satisfiesEngine(p.declared, host) : null
  const mark = r === true ? '✅' : (r === null ? '❓' : '❌')
  if (r === true) localOk++
  else if (r === false) hardFail++
  console.log(`  ${mark} ${p.name.padEnd(30)} 声明 ${String(p.declared || '(缺失)').padEnd(12)} ${r === null ? '（无法判定 ⇒ 不得当通过）' : ''}`)
}
console.log(`  → ${localOk}/${locals.length} 在声明上支持 ${host}`)

console.log('\n【二】第三方插件（4 个，' + (OFFLINE ? 'offline 跳过' : '实查 npm：找声明支持该宿主的最高版本') + '）')
if (OFFLINE) {
  console.log('  （offline 模式不查网；第三方结论请看 plugins/dsh-adapter/compat-matrix.json）')
} else {
  for (const pkg of THIRD_PARTY) {
    const r = newestDeclaringVersion(pkg, host)
    if (r.error) { console.log(`  ⚠️  ${pkg.padEnd(34)} ${r.error}`); continue }
    if (r.version) {
      const isLatest = r.version === r.latest
      console.log(`  ✅ ${pkg.padEnd(34)} 最高可用 ${r.version}${isLatest ? '（= 最新版）' : `（最新版是 ${r.latest}，但它不支持 ${host}）`}`)
    } else {
      console.log(`  ❌ ${pkg.padEnd(34)} **没有任何版本**声明支持 ${host}（最新版 ${r.latest}；往回扫了 ${r.scanned} 个）`)
      console.log('       ⇒ 不是"要退版"，而是"上游从未声明支持"。请对照 compat-matrix.json 里该项的实测结论，并务必冒烟。')
      hardFail++
    }
  }
}

console.log('\n============================================================')
if (hardFail === 0) {
  console.log('✅ 结论：所有插件都在声明上支持 ' + host)
  process.exit(0)
}
console.log(`⚠️  结论：有 ${hardFail} 项在声明上不支持 ${host}`)
console.log('    声明不匹配 ≠ 一定不可用 —— adapter 的 evaluate() 会用能力探针给出')
console.log('    capabilities-ok / capability-gaps 的兜底判定。但**必须先冒烟再上线**。')
process.exit(1)
