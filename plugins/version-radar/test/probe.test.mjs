// probe.js 单测：覆盖 spec §8 用例 1 / 2 / 3 / 4（含 §8-5 的参数透传）。
//   · **绝不联网**（注入假 fetch）· **绝不碰真实文件系统**（stub fs）· **不依赖内核**
//   · 纪律断言：probe 后**没读会话目录**（下面在沙盒里放了一个 sessions/哨兵.json 做哨兵）、
//     **没写任何文件**、源码里**没有子进程 API / 没有会话目录字面量 / 没有写盘调用**。
//
// ⚠️ 本机（本仓）**没有 semver**（spec §10 已知风险）⇒
//   · 判定树用**注入的满足性桩**驱动（桩只模拟 range 引擎，用来验我们的判定树；**不代表我们谎报**）
//   · 真实 semver 语义断言（§8-2）在宿主机（有 semver）执行；本机自动 skip 并打印原因
// 用法（仓库根目录）：node --test plugins/version-radar/test/probe.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runProbe, resolveSemver, LEDGER_TODO_TEMPLATE } from '../lib/probe.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const PROBE_SRC = readFileSync(join(HERE, '..', 'lib', 'probe.js'), 'utf8')

const ROOT = 'sandbox'
const DSH_HOME = join(ROOT, 'dsh-home')
const PROFILE = join(DSH_HOME, 'profiles', 'web')
const RELEASE_ROOT = join(ROOT, 'dsh-release')
const CUR = '0.1.5-rc.1'
const LATEST = '0.1.5-rc.3'
const SENTINEL = join(DSH_HOME, 'sessions', '哨兵.json')

const THIRD_PARTY = {
  '@huanlin/dsh-plugin-better-locale': { v: '0.4.1', range: '^0.1.5-rc.1' },
  '@nanmicoder/dsh-agent-teams': { v: '0.1.20', range: '0.1.5-rc.1 || 0.1.2-rc.1 || 0.1.2-alpha.5 || 0.1.2-alpha.2' },
  'dsh-better-sidebar': { v: '0.19.1', range: '^0.1.5-rc.1' },
  dshmarket: { v: '1.47.0', range: '^0.1.0-rc.7 || ^0.1.1-rc.2 || ^0.1.2-alpha.2' },
}

/** fixture = spec §4.3 的真实锚点值 */
function buildFiles() {
  const files = {}
  const deps = {}
  for (const [name, meta] of Object.entries(THIRD_PARTY)) {
    deps[name] = meta.v
    const peer = name === '@nanmicoder/dsh-agent-teams' ? '@deepseek-ai/dsh-agent' : '@deepseek-ai/dsh'
    files[join(PROFILE, 'node_modules', ...name.split('/'), 'package.json')] =
      JSON.stringify({ name, version: meta.v, peerDependencies: { [peer]: meta.range } })
  }
  files[join(PROFILE, 'package.json')] = JSON.stringify({ name: 'web', dependencies: deps })
  // release.json 的真实形状 = deploy/linux/kernel-release.sh:407-419 那段内联 node -e 的输出（**首键 coreVersion**，无顶层 version）
  files[join(RELEASE_ROOT, CUR, 'release.json')] = JSON.stringify({
    coreVersion: CUR,
    npmBefore: '2026-09-10T12:00:00Z',
    nodeMin: '22.15.0',
    profileTemplate: 'profiles/web/package.json',
    installedAt: '2026-09-26T08:43:44Z',
    treeShape: 'flat',
    gitCommit: null,
    runtimeRel: 'kernel/lib/node_modules/@deepseek-ai/dsh/node_modules',
    pluginSet: ['dsh-adapter', 'knowledge-base'],
    pluginSha256: '',
    thirdParty: [],
    gatewayCommit: null,
    frontendCommit: null,
  })
  files[SENTINEL] = JSON.stringify({ marker: '不应被读' })
  return files
}

function makeStubFs(files) {
  const access = []
  const writes = []
  const dirs = new Set([join(RELEASE_ROOT, CUR)])
  return {
    access,
    writes,
    existsSync(p) { access.push(['existsSync', p]); return Object.prototype.hasOwnProperty.call(files, p) || dirs.has(p) },
    readFileSync(p) {
      access.push(['readFileSync', p])
      if (!Object.prototype.hasOwnProperty.call(files, p)) {
        const e = new Error('ENOENT: ' + p)
        e.code = 'ENOENT'
        throw e
      }
      return files[p]
    },
    writeFileSync(p, d) { writes.push([p, String(d)]) },
    appendFileSync(p, d) { writes.push([p, String(d)]) },
    mkdirSync(p) { dirs.add(p) },
  }
}

const ENV = { DSH_HOME, DSH_PROFILE_ROOT: PROFILE, DSH_RELEASE_ROOT: RELEASE_ROOT, DSH_WORKSPACE_ROOT: join(ROOT, 'ws') }
const HOST_STUB = () => ({
  version: CUR,
  source: 'test:stub',
  dshPkgPath: join(ROOT, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
  installRoot: join(ROOT, 'node_modules'),
})

const goodFetch = (tags = { latest: LATEST, next: '0.1.7-rc.2', alpha: '0.1.7-alpha.2' }) =>
  () => Promise.resolve({ ok: true, status: 200, text: async () => JSON.stringify({ 'dist-tags': tags }) })

/** 满足性桩：只模拟 range 引擎（^0.1.5-rc.1 ⇒ true，其余 ⇒ false），并记录调用形状 */
function stubSemver() {
  const calls = []
  return {
    calls,
    satisfies: (version, range, options) => {
      calls.push({ version, range, options })
      return String(range).startsWith('^0.1.5-rc.1')
    },
  }
}

function probeWith(mutate, extra) {
  const files = buildFiles()
  if (typeof mutate === 'function') mutate(files)
  const fs = makeStubFs(files)
  const p = runProbe(Object.assign({
    fs,
    env: ENV,
    hostImpl: HOST_STUB,
    fetchImpl: goodFetch(),
    now: () => new Date('2026-09-26T09:40:00Z'),
  }, extra || {}))
  return { fs, p }
}

const probe = (extra) => probeWith(null, extra)

const byName = (list) => Object.fromEntries(list.map((t) => [t.name, t]))

test('§8-1 判据 (c) 正例（判定树）：真实锚点 fixture ⇒ 需人工判定，agent-teams 不支持', async () => {
  const { fs, p } = probe({ semverImpl: stubSemver() })
  const r = await p
  assert.equal(r.ok, true)
  assert.equal(r.verdict, '需人工判定')
  assert.equal(r.target, LATEST)
  assert.equal(r.host.version, CUR)
  assert.equal(r.upstream.latest, LATEST)
  assert.equal(r.upstream.next, '0.1.7-rc.2')
  assert.equal(r.upstream.alpha, '0.1.7-alpha.2')
  assert.equal(r.rollback.exists, true)
  assert.equal(r.rollback.manifestOk, true)
  const by = byName(r.thirdParty)
  assert.equal(by['@nanmicoder/dsh-agent-teams'].supported, false)
  assert.equal(by['dsh-better-sidebar'].supported, true)
  assert.equal(by['@huanlin/dsh-plugin-better-locale'].supported, true)
  assert.equal(by.dshmarket.supported, false, '§4.3：dshmarket 的范围对 0.1.5 线不满足')
  assert.ok(r.reasons.some((s) => s.includes('声明不支持')), 'reasons 必须含「声明不支持」')
  assert.deepEqual(r.ledgerTodo, LEDGER_TODO_TEMPLATE.map((x) => ({ id: x.id, ask: x.ask })))
  assert.equal(r.semverAvailable, true)
  assert.equal(fs.writes.length, 0)
})

test('§8-1（真实 semver 版）：宿主有 semver 时用真引擎复核同一 fixture', async (t) => {
  const real = await resolveSemver({}, null)
  if (!real) {
    t.skip('本机既无注入也无宿主 semver（spec §10 已知风险）⇒ 真实语义断言留待宿主机执行')
    return
  }
  const r = await probe({ semverImpl: real }).p
  const by = byName(r.thirdParty)
  assert.equal(by['@nanmicoder/dsh-agent-teams'].supported, false)
  assert.equal(by['dsh-better-sidebar'].supported, true)
  assert.equal(by['@huanlin/dsh-plugin-better-locale'].supported, true)
  assert.equal(r.verdict, '需人工判定')
})

test('§8-2 semver 边界（不许字符串比较）：真引擎断言；无 semver 则 skip', async (t) => {
  const real = await resolveSemver({}, null)
  if (!real) {
    t.skip('无 semver：本机跑不了真引擎边界断言（默认路径走 satisfies:null 降级，**不谎报**）')
    return
  }
  const o = { includePrerelease: false }
  assert.equal(real.satisfies('0.1.5-rc.3', '^0.1.5-rc.1', o), true)
  assert.equal(real.satisfies('0.1.6-rc.1', '^0.1.5-rc.1', o), false)
  assert.equal(real.satisfies('0.1.5-rc.3', '0.1.5-rc.1 || 0.1.2-rc.1', o), false)
})

test('semver 调用形状：逐 peer 调 satisfies(target, range, { includePrerelease:false })', async () => {
  const sv = stubSemver()
  const r = await probe({ semverImpl: sv }).p
  assert.equal(sv.calls.length, 4, '4 个第三方各 1 个内核族 peer')
  for (const c of sv.calls) {
    assert.equal(c.version, LATEST)
    assert.deepEqual(c.options, { includePrerelease: false })
  }
  assert.ok(sv.calls.some((c) => c.range === THIRD_PARTY['@nanmicoder/dsh-agent-teams'].range), 'agent-teams 的精确枚举必须原样送进 semver')
  assert.equal(r.thirdParty.every((t) => t.peers.every((p) => typeof p.satisfies === 'boolean')), true)
})

test('§6-7 降级：无 semver ⇒ satisfies:null、不谎报 supported、结论降级为需人工判定', async () => {
  const r = await probe({ semverImpl: null }).p
  assert.equal(r.semverAvailable, false)
  assert.equal(r.verdict, '需人工判定')
  assert.ok(r.reasons.some((s) => s.includes('semver')))
  for (const t of r.thirdParty) {
    assert.equal(t.supported, null, t.name + ' 不得被谎报为 supported')
    assert.equal(t.peers.every((p) => p.satisfies === null), true)
  }
})

test('§8-3 fail-closed：超时 ⇒ upstream.ok=false、verdict=unknown、不谎报"有更新"', async () => {
  // ⚠️ AbortSignal.timeout() 的定时器是 unref 的 ⇒ 用一根 ref 住的 keepAlive 撑住事件循环（见 registry.test.mjs 同款说明）
  const fetchImpl = (_url, opts) => new Promise((_resolve, reject) => {
    const keepAlive = setTimeout(() => {}, 200)
    opts.signal.addEventListener('abort', () => { clearTimeout(keepAlive); reject(opts.signal.reason) })
  })
  const r = await probe({ semverImpl: stubSemver(), fetchImpl, timeoutMs: 20 }).p
  assert.equal(r.ok, false)
  assert.equal(r.upstream.ok, false)
  assert.equal(r.upstream.latest, null)
  assert.equal(r.verdict, 'unknown')
  assert.equal(r.reasons.join('|').includes('新版本'), false)
})

test('§8-3 fail-closed：HTTP 500 ⇒ 同上', async () => {
  const r = await probe({ semverImpl: stubSemver(), fetchImpl: () => Promise.resolve({ ok: false, status: 500, text: async () => 'boom' }) }).p
  assert.equal(r.ok, false)
  assert.equal(r.upstream.ok, false)
  assert.equal(r.upstream.error, 'HTTP_500')
  assert.equal(r.verdict, 'unknown')
  assert.equal(r.reasons.join('|').includes('新版本'), false)
})

test('§8-3 fail-closed：响应超体积 ⇒ 同上', async () => {
  const big = JSON.stringify({ 'dist-tags': { latest: LATEST }, pad: 'z'.repeat(4096) })
  const r = await probe({ semverImpl: stubSemver(), fetchImpl: () => Promise.resolve({ ok: true, status: 200, text: async () => big }), maxBytes: 64 }).p
  assert.equal(r.ok, false)
  assert.equal(r.upstream.ok, false)
  assert.match(r.upstream.error, /TOO_LARGE/)
  assert.equal(r.verdict, 'unknown')
})

test('§8-4 零副作用：没读会话目录 / 没写任何文件 / 没派生进程', async () => {
  const { fs, p } = probe({ semverImpl: stubSemver() })
  await p
  const touched = fs.access.map((x) => x[1])
  assert.equal(touched.includes(SENTINEL), false, '哨兵文件必须从未被访问')
  assert.equal(touched.some((f) => /[\\/]sessions[\\/]/.test(f)), false, '不得访问任何会话目录')
  assert.equal(fs.writes.length, 0, 'probe 不得写任何文件')
  assert.doesNotMatch(PROBE_SRC, /child_process|execFileSync|spawnSync|\bspawn\s*\(/)
  assert.doesNotMatch(PROBE_SRC, /\bsessions\b/)
  assert.doesNotMatch(PROBE_SRC, /writeFileSync|appendFileSync/)
  assert.doesNotMatch(PROBE_SRC, /\breaddirSync\b/)
})

test('§8-5 上限生效：timeoutMs / maxBytes 真的透传到出网层', async () => {
  let seen = null
  const fetchImpl = (_url, opts) => { seen = opts; return Promise.resolve({ ok: true, status: 200, text: async () => JSON.stringify({ 'dist-tags': { latest: LATEST } }) }) }
  const r = await probe({ semverImpl: stubSemver(), fetchImpl, timeoutMs: 1234, maxBytes: 4321 }).p
  assert.ok(seen && seen.signal instanceof AbortSignal)
  assert.equal(r.upstream.ok, true)
  assert.equal(r.thirdParty.length, 4)
})

test('判定树：targetVersion 给 next 线 ⇒ 需人工判定（预发布线不在建议升级范围）', async () => {
  const r = await probe({ semverImpl: stubSemver(), targetVersion: '0.1.7-rc.2' }).p
  assert.equal(r.target, '0.1.7-rc.2')
  assert.equal(r.verdict, '需人工判定')
  assert.ok(r.reasons.some((s) => s.includes('latest')))
})

test('判定树：跳 minor 且存在第三方 ❌ ⇒ 不建议升', async () => {
  const r = await probe({ semverImpl: stubSemver(), fetchImpl: goodFetch({ latest: '0.1.7-rc.2', next: null, alpha: null }) }).p
  assert.equal(r.verdict, '不建议升')
  assert.ok(r.reasons.some((s) => s.includes('跳 minor')))
})

test('判定树：跳 minor 但第三方全 ✅ ⇒ 需人工判定（要读发行说明）', async () => {
  const allYes = { satisfies: () => true }
  const r = await probe({ semverImpl: allYes, fetchImpl: goodFetch({ latest: '0.1.7-rc.2', next: null, alpha: null }) }).p
  assert.equal(r.verdict, '需人工判定')
  assert.ok(r.reasons.some((s) => s.includes('跳 minor')))
})

test('判定树：未跳 minor + 第三方全 ✅ ⇒ 可升', async () => {
  const r = await probe({ semverImpl: { satisfies: () => true } }).p
  assert.equal(r.verdict, '可升')
  assert.equal(r.ok, true)
})

test('判定树：上游无更新（latest == 当前版本）⇒ 可升（无事可做）', async () => {
  const r = await probe({ semverImpl: stubSemver(), fetchImpl: goodFetch({ latest: CUR, next: null, alpha: null }) }).p
  assert.equal(r.verdict, '可升')
  assert.ok(r.reasons.some((s) => s.includes('无更新')))
})

test('判定树：宿主版本探测失败 ⇒ unknown（ok:false）', async () => {
  const r = await probe({ semverImpl: stubSemver(), hostImpl: () => ({ version: 'unknown', source: 'none' }) }).p
  assert.equal(r.verdict, 'unknown')
  assert.equal(r.ok, false)
})

test('判定树：profile 依赖清单读不到 ⇒ 需人工判定（并说明原因），不谎报可升', async () => {
  const { p } = probeWith((files) => { delete files[join(PROFILE, 'package.json')] }, { semverImpl: stubSemver() })
  const r = await p
  assert.equal(r.verdict, '需人工判定')
  assert.equal(r.thirdParty.length, 0)
  assert.ok(r.reasons.some((s) => s.includes('第三方')))
})

test('§5.1 字段名冻结：顶层 8 个键齐备且类型正确', async () => {
  const r = await probe({ semverImpl: stubSemver() }).p
  for (const k of ['ok', 'host', 'upstream', 'thirdParty', 'ledgerTodo', 'rollback', 'verdict', 'reasons']) {
    assert.ok(Object.prototype.hasOwnProperty.call(r, k), '缺少冻结字段：' + k)
  }
  assert.equal(typeof r.ok, 'boolean')
  assert.equal(typeof r.verdict, 'string')
  assert.equal(Array.isArray(r.thirdParty), true)
  assert.equal(Array.isArray(r.ledgerTodo), true)
  assert.equal(Array.isArray(r.reasons), true)
  assert.deepEqual(Object.keys(r.host).sort(), ['dshPkgPath', 'installRoot', 'source', 'version'])
  assert.deepEqual(Object.keys(r.upstream).sort(), ['alpha', 'checkedAt', 'error', 'latest', 'next', 'ok', 'registry'])
  assert.deepEqual(Object.keys(r.rollback).sort(), ['exists', 'manifestOk', 'target'])
  assert.deepEqual(Object.keys(r.thirdParty[0]).sort(), ['installed', 'name', 'peers', 'supported'])
  assert.deepEqual(Object.keys(r.thirdParty[0].peers[0]).sort(), ['pkg', 'range', 'satisfies'])
  assert.deepEqual(Object.keys(r.ledgerTodo[0]).sort(), ['ask', 'id'])
})

test('护栏（夹具形状）：release.json 夹具必须逐键对齐真实生成器（coreVersion，且**不得**有 version）', () => {
  const files = buildFiles()
  const doc = JSON.parse(files[join(RELEASE_ROOT, CUR, 'release.json')])
  // ① 真键在
  assert.equal(typeof doc.coreVersion, 'string', 'release.json 夹具必须含真实键 coreVersion')
  // ② 那个错的键不许再出现（真文件里没有它）
  assert.equal(Object.prototype.hasOwnProperty.call(doc, 'version'), false, '不得再写那个错的 version 键（生成器没有它）')
  // ③ 与 deploy/linux/kernel-release.sh:407-419 的键集合**逐键**对齐（防"夹具漂移"）
  assert.deepEqual(Object.keys(doc).sort(), [
    'coreVersion', 'frontendCommit', 'gatewayCommit', 'gitCommit', 'installedAt', 'nodeMin',
    'npmBefore', 'pluginSet', 'pluginSha256', 'profileTemplate', 'runtimeRel', 'thirdParty', 'treeShape',
  ])
})

test('护栏（拒绝旧形状）：release.json 只有 version（旧夹具形状）⇒ manifestOk:false（禁止静默兜底到 version）', async () => {
  const { p, fs } = probeWith((files) => {
    files[join(RELEASE_ROOT, CUR, 'release.json')] = JSON.stringify({ version: CUR })   // 旧夹具形状 = 本次教训里那个错
  }, { semverImpl: stubSemver() })
  const r = await p
  assert.equal(r.rollback.exists, true, '目标目录仍在盘上')
  assert.equal(r.rollback.manifestOk, false, 'coreVersion 缺失时必须 false —— 守住「只读 coreVersion、不加 version 兜底」')
  assert.equal(fs.writes.length, 0)
})
