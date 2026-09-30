// @local/version-radar —— probe.js：版本检测核心（一次完整检测；零副作用、可独立单测）
//
// 五项事实（spec §4.1）：
//   ① 当前内核版本    : detectHost()（静态 import 自 @local/dsh-adapter，spec §7-a）
//   ② 上游走到哪      : registry.js 的 fetchDistTags()（唯一出网；**只取 dist-tags**）
//   ③ 第三方支持范围  : profile 的 dependencies ∩ 各包 peerDependencies × semver 求交（spec §6-7）
//   ④ 本地改动待办    : 内建模板（spec §4.1-4「内建，不读仓库文件」）
//   ⑤ 回滚目标在盘否  : <DSH_RELEASE_ROOT>/<当前ver>/ 是否存在 + release.json 可读
//
// 纪律落地：
//   1 禁启动期联网：本文件顶层**零网络调用**；出网只发生在 runProbe() 被显式调用时。
//   2 不派生任何子进程：源码不含子进程 API（见 test/probe.test.mjs 的源码扫描断言）。
//   3 不读会话目录：源码里连会话目录的字面量都不出现（同上断言）。
//   4 不递归扫盘：只读固定几个 package.json + 一个 compat-matrix.json；不递归列目录。
//   5 只建议不执行：本文件**没有任何写盘 / 翻软链 / 重启**的代码路径。
//
// 注入点（spec §3.2 的「参数默认值」手法，不引入 DI 框架）：
//   fs / fetchImpl / env / now —— 测试全部注入；hostImpl / semverImpl 同法（默认走真实实现）。
//   ⚠️ 本机（本仓）**没有 semver** ⇒ 默认解析为 null ⇒ 按 spec §6-7 降级（satisfies:null +
//      结论降级为「需人工判定」），**绝不谎报 supported**。

import fsDefault from 'node:fs'
import { join, dirname } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { detectHost } from '../../dsh-adapter/lib/version.js'
import { fetchDistTags } from './registry.js'

/** 结论取值（spec §4.2-v） */
const V_UPGRADABLE = '可升'
const V_MANUAL = '需人工判定'
const V_NO = '不建议升'
const V_UNKNOWN = 'unknown'

/** 出网参数默认值（spec §6-5：256 KB / 8 s） */
const TIMEOUT_MS = 8000
const MAX_BYTES = 256 * 1024

/** 判定「第三方」的口径：profile 里非内核、非自研的依赖（spec §4.1-3） */
const EXCLUDE_PREFIXES = ['@deepseek-ai/', '@local/']

/** peerDependencies 里只关心内核族（@deepseek-ai/dsh、@deepseek-ai/dsh-agent …） */
const KERNEL_PEER_PREFIX = '@deepseek-ai/dsh'

/** 本地改动台账「第 9 栏模板」（spec §4.1-4：内建；第二阶段随 C-7 登记一并人工同步） */
export const LEDGER_TODO_TEMPLATE = Object.freeze([
  { id: 'C-*', ask: '逐条核对台账里 C-*（代码级改动）：该改动打在的**上游文件**在新版本里是否仍存在、行号与段落是否漂移；漂移 ⇒ 需重制补丁。' },
  { id: 'F-*', ask: '逐条核对台账里 F-*（功能/配置级改动）：新版本是否已**原生提供**同能力（已提供 ⇒ 改为删除本地改动，而不是重制补丁）。' },
  { id: 'K-rollback', ask: '整包替换前先跑 kernel-release.sh 的 dry-run / preflight（人工触发）；本插件只建议、不执行。' },
])

const MSG = (e) => String((e && e.message) || e)

const readText = (fs, p) => {
  try { return fs.readFileSync(p, 'utf8') } catch (_) { return null }
}

const readJson = (fs, p) => {
  const t = readText(fs, p)
  if (t == null) return null
  try { return JSON.parse(t) } catch (_) { return null }
}

/** 数字化的版本拆解（**不是**前缀/字符串比较：拆成数字再比大小；仅用于「跳 minor」信号） */
function parseVersion(v) {
  const m = String(v == null ? '' : v).trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/)
  if (!m) return null
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), prerelease: m[4] || null, raw: String(v).trim() }
}

/**
 * semver 解析：注入优先 → `import('semver')` → 宿主安装根兜底；都拿不到 ⇒ null（降级，不谎报）。
 * 宿主机上插件经 profile 的 node_modules 解析 ⇒ 动态 import 会命中内核顶层 node_modules 的 semver。
 * @param {{ semverImpl?: object|null }} opts
 * @param {{ installRoot?: string|null, dshPkgPath?: string|null }|null} host
 */
export async function resolveSemver(opts, host) {
  const o = opts || {}
  if (Object.prototype.hasOwnProperty.call(o, 'semverImpl')) {
    const s = o.semverImpl
    return (s && typeof s.satisfies === 'function') ? s : null
  }
  const shape = (m) => {
    if (m && typeof m.satisfies === 'function') return m
    if (m && m.default && typeof m.default.satisfies === 'function') return m.default
    return null
  }
  try {
    const found = shape(await import('semver'))
    if (found) return found
  } catch (_) { /* 继续兜底 */ }
  const bases = []
  if (host && host.installRoot) bases.push(host.installRoot)
  if (host && host.dshPkgPath) bases.push(dirname(host.dshPkgPath))
  for (const base of bases) {
    for (const rel of [join('semver', 'index.js'), join('node_modules', 'semver', 'index.js')]) {
      try {
        const found = shape(await import(pathToFileURL(join(base, rel)).href))
        if (found) return found
      } catch (_) { /* 下一个候选 */ }
    }
  }
  return null
}

/** ① 宿主版本（探测失败也要给出冻结字段，绝不抛） */
function probeHost(hostImpl) {
  try {
    const h = hostImpl() || {}
    return {
      version: (typeof h.version === 'string' && h.version) ? h.version : 'unknown',
      source: (typeof h.source === 'string') ? h.source : 'none',
      dshPkgPath: h.dshPkgPath || null,
      installRoot: h.installRoot || null,
    }
  } catch (e) {
    return { version: 'unknown', source: 'error:' + MSG(e), dshPkgPath: null, installRoot: null }
  }
}

/** ② 把出网结果映射成 spec §5.1 冻结的 upstream 形状 */
function mapUpstream(raw, checkedAt) {
  const ok = raw && raw.ok === true
  return {
    ok,
    registry: (raw && raw.registry) || 'registry.npmjs.org',
    latest: ok ? (raw.distTags && raw.distTags.latest) || null : null,
    next: ok ? (raw.distTags && raw.distTags.next) || null : null,
    alpha: ok ? (raw.distTags && raw.distTags.alpha) || null : null,
    checkedAt: String(checkedAt || ''),
    error: ok ? null : String((raw && raw.error) || 'UNKNOWN'),
  }
}

/** profile 根：显式 env 优先，否则 <DSH_HOME>/profiles/web（本部署的 profile 名） */
function resolveProfileRoot(env) {
  const explicit = String(env.DSH_PROFILE_ROOT || '').trim()
  if (explicit) return explicit
  const home = String(env.DSH_HOME || '').trim() || '/srv/dsh-home'
  return join(home, 'profiles', 'web')
}

/** 从 profile package.json 现场收集「第三方」包名（不硬编码包名；排除内核与自研） */
function collectThirdPartyDeps(profilePkg) {
  const names = new Set()
  for (const key of ['dependencies', 'optionalDependencies']) {
    const block = profilePkg && profilePkg[key]
    if (!block || typeof block !== 'object') continue
    for (const name of Object.keys(block)) {
      if (EXCLUDE_PREFIXES.some((p) => name.startsWith(p))) continue
      names.add(name)
    }
  }
  return [...names].sort()
}

/** semver 求交（真跑；拿不到引擎或引擎抛错 ⇒ null，不谎报） */
function satisfiesSafe(semver, version, range) {
  if (!semver || !version || !range) return null
  try {
    const r = semver.satisfies(String(version), String(range), { includePrerelease: false })
    return (r === true || r === false) ? r : null
  } catch (_) { return null }
}

/** ③ 第三方插件支持范围（spec §4.1-3 / §4.2-ii） */
function probeThirdParty({ fs, profileRoot, target, semver }) {
  const list = []
  const notes = []
  if (!profileRoot) {
    notes.push('profile 根未知（未设 DSH_HOME / DSH_PROFILE_ROOT）⇒ 第三方支持范围无法判定')
    return { list, notes, profileOk: false }
  }
  const profilePkgPath = join(profileRoot, 'package.json')
  const profilePkg = readJson(fs, profilePkgPath)
  if (!profilePkg) {
    notes.push('profile 依赖清单不可读：' + profilePkgPath + ' ⇒ 第三方支持范围无法判定')
    return { list, notes, profileOk: false }
  }
  for (const name of collectThirdPartyDeps(profilePkg)) {
    const pkgPath = join(profileRoot, 'node_modules', ...name.split('/'), 'package.json')
    const pkg = readJson(fs, pkgPath)
    const installed = (pkg && typeof pkg.version === 'string') ? pkg.version : null
    const peers = []
    const peerBlock = pkg && pkg.peerDependencies
    if (peerBlock && typeof peerBlock === 'object') {
      for (const key of Object.keys(peerBlock).sort()) {
        if (!key.startsWith(KERNEL_PEER_PREFIX)) continue
        const range = String(peerBlock[key])
        peers.push({ pkg: key, range, satisfies: satisfiesSafe(semver, target, range) })
      }
    }
    const known = peers.filter((p) => p.satisfies !== null)
    list.push({
      name,
      installed,
      peers,
      supported: (peers.length === 0 || known.length === 0) ? null : known.every((p) => p.satisfies === true),
    })
  }
  return { list, notes, profileOk: true }
}

/** ④ 回滚目标是否在盘上（spec §4.1-5） */
function probeRollback({ fs, env, hostVersion }) {
  const root = String(env.DSH_RELEASE_ROOT || '').trim() || '/usr/local/dsh-release'
  const target = join(root, hostVersion)
  const exists = (typeof fs.existsSync === 'function') ? fs.existsSync(target) === true : false
  const manifest = exists ? readJson(fs, join(target, 'release.json')) : null
  // ⚠️ release.json 的"版本"键名是 **coreVersion**，不是 version：
  //    生成侧 = deploy/linux/kernel-release.sh:407-419（那段内联 node -e 写出的首键就是 coreVersion）；
  //    契约   = docs/superpowers/plans/2026-09-26-manual-whole-package-kernel-upgrade-design.md §②-10（`:819`）。
  //    ⇒ 这里**只认 coreVersion**。若将来格式又变，正确做法 = 改本行 + 同步 test/probe.test.mjs 的夹具
  //      （有"夹具形状 / 拒绝旧形状"两条护栏拦住），**而不是**加 `|| manifest.version` 这类静默兜底
  //      —— 兜底会让"格式变了"悄悄通过，与本插件「不谎报」的定位冲突。
  return { target, exists, manifestOk: Boolean(manifest && typeof manifest.coreVersion === 'string') }
}

/** iv 有没有 breaking 的旁证：compat-matrix.json 里本宿主的实测 notes（best-effort，缺了不影响判定） */
function probeCompatNotes({ fs, hostVersion }) {
  const path = (() => { try { return fileURLToPath(new URL('../../dsh-adapter/compat-matrix.json', import.meta.url)) } catch (_) { return null } })()
  const doc = path ? readJson(fs, path) : null
  if (!doc || !Array.isArray(doc.hosts)) return { path, found: false, notes: null }
  const hit = doc.hosts.find((h) => h && h.host === hostVersion)
  return { path, found: Boolean(hit), notes: (hit && typeof hit.notes === 'string') ? hit.notes : null }
}

/**
 * spec §4.2 判定树（**按序短路**）。
 * 前置短路（fail-closed 与「无更新」） → 降级判定 → ③④⑤⑥⑦。
 */
function decide({ host, upstream, thirdParty, target, semver, compat, profileOk }) {
  const reasons = []
  const unsupported = thirdParty.filter((t) => t.supported !== true)
  const names = unsupported.map((t) => t.name + '@' + (t.installed || '?')).join('、')

  // ① 出网失败 / packument 解析失败 ⇒ unknown（fail-closed：**绝不**当作"有更新"）
  if (upstream.ok !== true) {
    return {
      verdict: V_UNKNOWN,
      reasons: [
        '上游 dist-tags 取不到（error=' + upstream.error + '）⇒ fail-closed：不给出「有更新」的判断',
        '出网或解析异常时不给升级建议，避免误导人工判断',
      ],
    }
  }
  if (host.version === 'unknown') {
    return { verdict: V_UNKNOWN, reasons: ['当前内核版本探测失败（source=' + host.source + '）⇒ 无基准可比'] }
  }
  // ② latest == 当前版本 ⇒ 可升（无事可做）
  if (target === host.version) {
    return { verdict: V_UPGRADABLE, reasons: ['上游无更新：目标版本 == 当前版本 ' + host.version + ' ⇒ 无事可做'] }
  }
  // spec §6-7：semver 拿不到 ⇒ satisfies 只能为 null，结论降级（不谎报）
  if (!semver) {
    return {
      verdict: V_MANUAL,
      reasons: [
        '无法解析 semver（宿主 node_modules 里没有 semver）⇒ 第三方 peer 只能给 satisfies:null，结论降级为「需人工判定」',
        '不谎报：既未判为「可升」，也未把无法判定的 peer 说成「不支持」',
      ],
    }
  }
  if (!profileOk) {
    return { verdict: V_MANUAL, reasons: reasons.concat('读不到 profile 依赖清单 ⇒ 无法判定第三方是否声明支持目标版本 ' + target) }
  }
  // ③ 目标版本是 next/alpha 线（非 latest）⇒ 需人工判定
  if (upstream.latest && target !== upstream.latest) {
    return {
      verdict: V_MANUAL,
      reasons: ['目标版本 ' + target + ' 不是 latest（latest=' + upstream.latest + '）⇒ 预发布线不在「建议升级」范围内'],
    }
  }
  const a = parseVersion(host.version)
  const b = parseVersion(target)
  // ⚠️ 口径（spec §4.2-iv① 原文把「0.1.5 → 0.1.7」称作「跳 minor」，而那是**第 3 位**）：
  //    这里取「**数字三元组任一位不同** ⇒ 算跳 minor 线」；预发布后缀变化（rc.1 → rc.3）不算跳。
  //    ⇒ 0.1.5-rc.1 → 0.1.5-rc.3 = 不跳（本轮实测场景，落 ⑥）；0.1.5 → 0.1.7 = 跳（落 ④/⑤）。
  const minorJump = Boolean(a && b && (a.major !== b.major || a.minor !== b.minor || a.patch !== b.patch))
  if (minorJump && unsupported.some((t) => t.supported === false)) {
    reasons.push('上游跳 minor 线（' + host.version + ' → ' + target + '）**且**存在第三方声明不支持：' + names)
    reasons.push('⇒ 现在别升：跳 minor + plugin 硬钉 peer，升上去大概率装不起来')
    return { verdict: V_NO, reasons }
  }
  if (minorJump) {
    reasons.push('上游跳 minor 线（' + host.version + ' → ' + target + '）⇒ 必须人工读发行说明找 breaking')
    if (unsupported.length) reasons.push('另有第三方未给出「支持」证据：' + names)
    if (compat && compat.notes) reasons.push('compat-matrix 里本条宿主的实测说明：' + compat.notes)
    return { verdict: V_MANUAL, reasons }
  }
  if (unsupported.length) {
    reasons.push('未跳 minor，但存在第三方**声明不支持**目标版本 ' + target + '：' + names)
    reasons.push('先确认这些插件有没有新版（有 ⇒ 先升插件；没有 ⇒ 需人工判定是否带风险升级）')
    if (compat && compat.notes) reasons.push('compat-matrix 里本条宿主的实测说明：' + compat.notes)
    return { verdict: V_MANUAL, reasons }
  }
  reasons.push('未跳 minor 且第三方 peer 全部满足 ' + target + ' ⇒ 可升（仍须先跑 kernel-release.sh 的 preflight）')
  return { verdict: V_UPGRADABLE, reasons }
}

/** 事实来源清单（进审计的 sources[]，便于事后追"为什么是这个版本/结论"） */
function buildSources({ host, upstream, profileRoot, compat }) {
  return [
    'host:' + host.source,
    'upstream:' + (upstream.ok ? upstream.registry + ' dist-tags' : 'unavailable(' + upstream.error + ')'),
    'profile:' + (profileRoot || 'unknown'),
    'compat-matrix:' + (compat.path ? (compat.found ? 'hit' : 'miss') : 'unavailable'),
  ]
}

/**
 * 一次完整检测。
 * @param {{ fs?: object, fetchImpl?: Function, env?: object, now?: Function, hostImpl?: Function,
 *           semverImpl?: object|null, targetVersion?: string, timeoutMs?: number, maxBytes?: number }} [opts]
 * @returns {Promise<object>} spec §5.1 结构（冻结字段 + 附加字段 target/semverAvailable/sources）
 */
export async function runProbe(opts) {
  const o = opts || {}
  const fs = o.fs || fsDefault
  const env = o.env || process.env || {}
  const now = (typeof o.now === 'function') ? o.now : (() => new Date())
  const hostImpl = (typeof o.hostImpl === 'function') ? o.hostImpl : detectHost

  const host = probeHost(hostImpl)
  const semver = await resolveSemver(o, host)
  const checkedAt = new Date(now()).toISOString()
  const upstream = mapUpstream(await fetchDistTags({ fetchImpl: o.fetchImpl, timeoutMs: o.timeoutMs, maxBytes: o.maxBytes }), checkedAt)
  const target = String(o.targetVersion || upstream.latest || host.version)
  const profileRoot = resolveProfileRoot(env)
  const tp = probeThirdParty({ fs, profileRoot, target, semver })
  const compat = probeCompatNotes({ fs, hostVersion: host.version })
  const rollback = probeRollback({ fs, env, hostVersion: host.version })
  const decided = decide({ host, upstream, thirdParty: tp.list, target, semver, compat, profileOk: tp.profileOk })

  return {
    ok: decided.verdict !== V_UNKNOWN,
    host,
    upstream,
    thirdParty: tp.list,
    ledgerTodo: LEDGER_TODO_TEMPLATE.map((x) => ({ id: x.id, ask: x.ask })),
    rollback,
    verdict: decided.verdict,
    reasons: decided.reasons.concat(tp.notes),
    target,
    semverAvailable: semver !== null,
    sources: buildSources({ host, upstream, profileRoot, compat }),
  }
}

export { MAX_BYTES, TIMEOUT_MS, V_MANUAL, V_NO, V_UNKNOWN, V_UPGRADABLE }
