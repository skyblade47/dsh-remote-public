#!/usr/bin/env node
// 插件挂载三栏对照（只读探针）：种子 bundles × 白名单 × 运行态
//
// 为什么需要它：check-ready 第 10 项原先只"列出 profile bundles + 报仓库里未挂载的自研插件"，
// 判据已过时 —— 现在插件走白名单（hotplug-manifest.yml），**不在** bundles 里，
// 旧判据会把"经白名单加载的插件"误报成"未挂载"。这里改成三栏对照：
//   A. 种子层：profile 的 dsh.profile.bundles（内核自己加载，不经 hotplug API）
//   B. 白名单：hotplug-manifest.yml 的 id / path / enabled
//   C. 运行态：GET /adapter/api/hotplug 的 entries[].id / loaded / tier
// 判据落在"B 与 C 的对照"上：enabled 但运行态未加载 ⇒ FAIL；enabled 但运行态未登记 ⇒ WARN。
//
// 用法：node server/scripts/report-hotplug-mounts.mjs <DSH_HOME>
// 退出码：0=一致；1=有 enabled 但运行态未加载；2=运行态 API 不可达（**≠** 不一致，两码事）
import fs from 'node:fs'
import path from 'node:path'

const KERNEL_PORT = 3080
const API_URL = `http://127.0.0.1:${KERNEL_PORT}/adapter/api/hotplug`
const RETRY_WAIT_MS = 10000

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const dshHome = process.argv[2] || process.env.DSH_HOME
if (!dshHome) {
  console.error('用法: node report-hotplug-mounts.mjs <DSH_HOME>')
  process.exit(2)
}

// 去掉 YAML 标量两侧的引号（本仓 serializYml 用 JSON.stringify，故是成对双引号；
// 手写时可能是单引号或不带引号，这里都兼容）。
function unquote(s) {
  const t = String(s).trim()
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1)
  }
  return t
}

// 极简解析 hotplug-manifest.yml：本文件由本仓自己写、格式稳定，只取成对的 id/path/enabled。
// 刻意不引入 YAML 依赖 —— 探针不该为一次检查多装一个包。逐条建对象，避免"三个数组按下标配对"的脆弱写法。
function parseManifest(text) {
  const out = []
  let cur = null
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    let m
    if ((m = line.match(/^-\s*id:\s*(.+)$/))) {
      if (cur) out.push(cur)
      cur = { id: unquote(m[1]), path: null, enabled: false }
    } else if (cur && (m = line.match(/^path:\s*(.+)$/))) {
      cur.path = unquote(m[1])
    } else if (cur && (m = line.match(/^enabled:\s*(.+)$/))) {
      cur.enabled = m[1].trim() === 'true'
    }
  }
  if (cur) out.push(cur)
  return out
}

async function readRuntimeEntries() {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch(API_URL, { signal: AbortSignal.timeout(5000) })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json() // 用 JSON.parse（res.json 底层即 JSON.parse）取 entries[]，绝不 grep JSON 文本
      return Array.isArray(data.entries) ? data.entries : []
    } catch (e) {
      if (attempt === 1) {
        console.log(`  （运行态 API 首次不可达：${(e && e.message) || e}）`)
        console.log('   内核可能仍在预热（加载 15 个插件约需 25–30 秒），等 10 秒后重试一次…')
        await sleep(RETRY_WAIT_MS)
      } else {
        throw e
      }
    }
  }
  throw new Error('unreachable')
}

// ---- A. 种子层：profile bundles ----
console.log('===== A. 种子层（profile bundles：内核自己加载，不经 hotplug API）=====')
const profilePkg = path.join(dshHome, 'profiles', 'web', 'package.json')
let bundles = []
if (!fs.existsSync(profilePkg)) {
  console.log(`  （找不到 ${profilePkg}）`)
} else {
  try {
    bundles = JSON.parse(fs.readFileSync(profilePkg, 'utf8')).dsh?.profile?.bundles || []
  } catch (e) {
    console.log(`  （解析 ${profilePkg} 失败：${e.message}）`)
  }
  console.log(`  profile: ${profilePkg}`)
  console.log(`  bundles 共 ${bundles.length} 条：`)
  for (const b of bundles) console.log(`    · ${b}`)
}

// ---- B. 白名单：hotplug-manifest.yml ----
console.log('\n===== B. 白名单（hotplug-manifest.yml）=====')
const ymlPath = path.join(dshHome, 'hotplug-manifest.yml')
let manifest = []
if (!fs.existsSync(ymlPath)) {
  console.log(`  （找不到 ${ymlPath}：无白名单）`)
} else {
  manifest = parseManifest(fs.readFileSync(ymlPath, 'utf8'))
  const enabled = manifest.filter((e) => e.enabled)
  const disabled = manifest.filter((e) => !e.enabled)
  console.log(`  文件: ${ymlPath}`)
  console.log(`  共 ${manifest.length} 条（enabled ${enabled.length} / disabled ${disabled.length}）：`)
  for (const e of manifest) console.log(`    · ${e.enabled ? '[on ]' : '[off]'} ${e.id} → ${e.path}`)
}

// ---- C. 运行态：/adapter/api/hotplug ----
console.log('\n===== C. 运行态（GET /adapter/api/hotplug）=====')
let runtime
try {
  runtime = await readRuntimeEntries()
} catch (e) {
  console.log(`  ❌ 运行态 API 不可达：${API_URL}（${(e && e.message) || e}）`)
  console.log('     内核可能仍在预热（加载 15 个插件约需 25–30 秒）—— 稍后重跑本探针即可，未必是不一致。')
  process.exit(2)
}
console.log(`  ${API_URL} → 200，entries[] ${runtime.length} 条：`)
for (const en of runtime) console.log(`    · ${en.id}  tier=${en.tier}  loaded=${en.loaded}`)

// ---- 对照结论 ----
console.log('\n===== 对照结论 =====')
const enabledEntries = manifest.filter((e) => e.enabled)
const byId = new Map(runtime.map((e) => [e.id, e]))
const notLoaded = []   // enabled 但运行态 loaded !== true
const unregistered = [] // enabled 但运行态中找不到同 id（未登记）
let loadedOk = 0
for (const e of enabledEntries) {
  const rt = byId.get(e.id)
  if (!rt) { unregistered.push(e.id); continue }
  if (rt.loaded === true) loadedOk++
  else notLoaded.push(e.id)
}

let exitCode = 0
if (notLoaded.length) {
  console.log(`❌ 白名单 ${notLoaded.length} 条 enabled 但未加载：${notLoaded.join(', ')}`)
  exitCode = 1
}
if (unregistered.length) {
  console.log(`⚠️  白名单 ${unregistered.length} 条 enabled 但在运行态中未登记：${unregistered.join(', ')}`)
}
if (enabledEntries.length > 0 && loadedOk === enabledEntries.length) {
  console.log(`✅ 白名单 ${enabledEntries.length} 条全部已加载`)
}
console.log(`—— 种子层 bundles ${bundles.length} 条：由内核自己加载、不经 hotplug API，故此处不做 running 核对。`)
console.log(`—— 白名单 disabled ${manifest.filter((e) => !e.enabled).length} 条（disabled 不算失败）。`)

process.exit(exitCode)
