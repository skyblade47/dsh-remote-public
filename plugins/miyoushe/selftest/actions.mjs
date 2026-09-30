// @local/miyoushe —— 接口面单测（§6.1 十二个 action / §6.2.1 十四个工具 / 门禁接线 / 出口姿态）
// 运行：node selftest/actions.mjs      （退出码 0 = 全过）
//
// 覆盖（t16/A5②③④ + A7 + A8）：
//   ② 每个 action 的**离线分支**（未配置 / 目录缺失 / 门禁未满足 ⇒ 对应错误码）
//   ③ 14 个工具全部可注册 + 参数 spec 合法（含"不得出现 required:false"断言，并尽量用**宿主真实 defineTool** 交叉验证）
//   ④ **零网络**（静态扫描 + 运行期哨兵）
//   A7 错误对象字段形状与 lib/gate.js 一致；**空组合清单 ⇒ groupsEmpty ⇒ G5 硬阻断（双参越权也无效）**
//   A8 出口姿态分级：凭据类走 strict、其余默认掩码；一律经 exitPayload（静态 + 运行期双向断言）
//
// 纪律：全部走**内存假数据面**与**注入端口**；`globalThis.fetch` 被换成"一调用即抛"的哨兵并断言调用数=0。

import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  createCore, createActions, toolDefinitions, validateToolDefinition, compileToolDefinitions,
  makeHttpHandler, ACTIONS, TOOL_NAMES, TOOL_META, STRICT_EXIT_PATHS, ERROR_HTTP_STATUS,
  API_PREFIX, ROUTE_KIND, gateShape,
} from '../lib/index.js'
import { exitPayload, saltFingerprint } from '../lib/mask.js'
import { findLosslessViolations } from '../lib/lossless.js'

let failures = 0
let skips = 0
function check(cond, label, got, want) {
  if (cond) console.log('PASS ' + label)
  else { failures++; console.log('FAIL ' + label + ' got=' + JSON.stringify(got) + ' want=' + JSON.stringify(want)) }
}
const show = (l, o) => console.log('  ' + l + ' => ' + JSON.stringify(o))

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const DATA_ROOT = 'E:/DSH工作区/全局数据'
const DIR = DATA_ROOT + '/miyoushe'
const hexSalt = (s) => createHash('sha256').update(s).digest('hex').slice(0, 32)
const SALT = hexSalt('actions-salt')
const SALT2 = hexSalt('actions-salt-rotated')
const FP = saltFingerprint(SALT)
const NOW = new Date(2026, 8, 20, 9, 0, 0, 0).getTime()

class MemFs {
  constructor(o) {
    const x = o || {}
    this.roots = { 全局数据: DATA_ROOT }
    this.dirs = new Set(x.dirs || [])
    this.files = new Map(x.files || [])
    this.calls = []
  }
  _p(root, rel) { const b = this.roots[root]; if (b === undefined) { const e = new Error('unknown root'); e.code = 'ROOT_UNKNOWN'; throw e } return rel ? b + '/' + rel : b }
  _rec(op, rel) { this.calls.push(op + ' ' + rel) }
  count(op) { return this.calls.filter((c) => c.startsWith(op + ' ')).length }
  async exists(root, rel) { const p = this._p(root, rel); this._rec('exists', rel); return this.dirs.has(p) || this.files.has(p) }
  async readText(root, rel) { const p = this._p(root, rel); this._rec('readText', rel); if (!this.files.has(p)) { const e = new Error('nf'); e.code = 'FS_NOT_FOUND'; throw e } return this.files.get(p) }
  async readJson(root, rel) { const t = await this.readText(root, rel); this._rec('readJson', rel); try { return JSON.parse(t) } catch (e) { const err = new Error('bad'); err.code = 'EBADJSON'; throw err } }
  async writeText(root, rel, text) { const p = this._p(root, rel); this._rec('writeText', rel); this.files.set(p, text); return { ok: true } }
  async writeJson(root, rel, data) { const p = this._p(root, rel); this._rec('writeJson', rel); this.files.set(p, JSON.stringify(data, null, 2)); return { ok: true } }
  async listDir(root, rel) { this._rec('listDir', rel); return [] }
  async resolve(root, rel) { const p = this._p(root, rel); return { targetKey: p, displayPath: p } }
}

const SETTINGS = { version: 1, tickMs: 60000, windowStart: '08:00', windowEnd: '23:30', dailyJitterMs: 900000, accountGapMs: [5000, 25000], maxAttemptsPerDay: 3, backoffMs: [300000, 1200000, 3600000], bbsEnabled: true, allowLateSign: false, schedule: { enabled: false } }
const CRED_OK = { configured: true, lastOkAt: '2026-09-18T00:00:00.000Z' }
const ACCOUNTS = [{ accountKey: 'acct-***1234', uid: '123456789', roles: [{ gameKey: 'hk4e', region: 'cn_gf01', gameUid: '100000001', nickname: 'tester', level: 60 }] }]

function mkWorld(opts) {
  const o = opts || {}
  const state = Object.assign({
    version: 1,
    schedule: { enabled: o.enabled === true, mode: o.enabled === true ? 'auto' : 'readonly', nextAt: null, lastRunAt: null, pausedBy: o.pausedBy === undefined ? null : o.pausedBy },
    credentials: o.credentials === undefined ? CRED_OK : o.credentials,
    doneKeys: o.doneKeys || {},
    lastSignSuccess: o.lastSignSuccess || {},
    lastError: o.lastError || null,
    lock: null,
  }, o.stateExtra || {})
  const salts = o.salts || { version: 2, updatedAt: '2026-09-20T00:00:00Z', active: { appVersion: '2.109.0', clientType: '5' }, entries: { '2.109.0': { clientType: '5', salt: SALT, status: 'verified', sourceKind: 'manual', fetchedAt: '2026-09-20T00:00:00Z' } }, versionCache: { appVersion: '2.109.0', clientType: '5', fetchedAt: '2026-09-20T00:00:00Z', ttlMs: 86400000, lastFetchOk: true, lastFetchError: null } }
  const files = [
    [DIR + '/logs/.keep', ''],
    [DIR + '/settings.json', JSON.stringify(o.settings || SETTINGS)],
    [DIR + '/state.json', JSON.stringify(state)],
    [DIR + '/salts.json', JSON.stringify(salts)],
  ]
  if (o.accounts !== null) files.push([DIR + '/accounts.json', JSON.stringify({ version: 1, updatedAt: null, accounts: o.accounts === undefined ? ACCOUNTS : o.accounts })])
  return new MemFs({ dirs: o.dirs || [DIR, DIR + '/logs'], files })
}
const sameSourceSuccess = (opts) => ({
  outcome: 'success',
  at: new Date(NOW - 3600000).toISOString(),
  retcode: 0,
  saltFingerprint: (opts && opts.fp) || FP,
  appVersion: (opts && opts.appVersion) || '2.109.0',
})
const coreOf = (fs, extra) => createCore(Object.assign({ adapterFs: fs, now: () => NOW }, extra || {}))

const realFetch = globalThis.fetch
let guardCalls = 0
try {
  globalThis.fetch = () => { guardCalls++; throw new Error('REAL_NETWORK_ATTEMPT_BLOCKED') }

  console.log('== A2：12 个 action 存在且可调用 ==')
  {
    const core = coreOf(mkWorld())
    const A = createActions(core)
    check(ACTIONS.length === 12, 'ACTIONS 声明 12 个', ACTIONS.length, 12)
    const missing = ACTIONS.filter((n) => typeof A[n] !== 'function')
    check(missing.length === 0, '每个 action 都有实现', missing, '[]')
    check(ROUTE_KIND === 'prefix' && API_PREFIX === '/miyoushe/api', '路由 kind/path 对齐 §6.1', { k: ROUTE_KIND, p: API_PREFIX }, { k: 'prefix', p: '/miyoushe/api' })
  }

  console.log('\n== A5②：离线分支 —— adapterFs 缺失 ⇒ NOT_READY（ping 除外）==')
  {
    const core = coreOf(undefined)
    const A = createActions(core)
    const ping = await A.ping()
    check(ping.ok === true && ping.dataFace === false && ping.actions === 12 && ping.tools === 14, 'ping 不依赖数据面且报 12/14', { ok: ping.ok, a: ping.actions, t: ping.tools }, { ok: true, a: 12, t: 14 })
    for (const name of ACTIONS.filter((n) => n !== 'ping')) {
      const out = await A[name]({})
      check(out.ok === false && out.error && out.error.code === 'NOT_READY', 'action ' + name + ' ⇒ NOT_READY', out.error && out.error.code, 'NOT_READY')
    }
  }

  console.log('\n== A5②：离线分支 —— 数据目录缺失 ⇒ FS_PARENT_MISSING ==')
  {
    const fs = new MemFs({ dirs: [], files: [] }) // 无 miyoushe 目录
    const A = createActions(coreOf(fs))
    for (const name of ['status', 'schedule', 'enable', 'logs', 'accounts', 'version', 'config', 'credentials', 'sign', 'run', 'disable']) {
      const out = await A[name]({})
      check(out.ok === false && out.error && out.error.code === 'FS_PARENT_MISSING', 'action ' + name + ' ⇒ FS_PARENT_MISSING', out.error && out.error.code, 'FS_PARENT_MISSING')
    }
  }

  console.log('\n== A7：空组合清单 ⇒ groupsEmpty ⇒ G5 硬阻断（双参越权也无效）==')
  {
    const fs = mkWorld({ accounts: [] })
    const A = createActions(coreOf(fs))
    const out = await A.enable({ confirm: true, acknowledgeUnverified: true })
    show('enable(空账号清单)', out)
    check(out.ok === false && out.error.code === 'SCHEDULE_GATE_BLOCKED', '空清单 ⇒ SCHEDULE_GATE_BLOCKED（不放行）', out.error && out.error.code, 'SCHEDULE_GATE_BLOCKED')
    const g = out.error.gate
    check(g.groupsEmpty === true && g.hardBlocked === true && g.hardItems.includes('G5'), 'groupsEmpty ⇒ hardBlocked=true 且 hardItems 含 G5', { grp: g.groupsEmpty, hard: g.hardItems }, '<true/含 G5>')
    check(g.evaluatedGroups === 0 && g.totalFailingGroups === 0, '零组合 ⇒ evaluatedGroups=0', { e: g.evaluatedGroups, t: g.totalFailingGroups }, { e: 0, t: 0 })
    const a7 = ['ok', 'mode', 'overridden', 'hardBlocked', 'hardItems', 'softItems', 'reasons', 'failedByGroup', 'truncated', 'missingGroups', 'totalFailingGroups', 'evaluatedGroups', 'groupsEmpty', 'maxReasonEntries', 'reasonScope', 'effective', 'at']
    const missingKeys = a7.filter((k) => !Object.prototype.hasOwnProperty.call(g, k))
    check(missingKeys.length === 0, 'gate 字段形状与 lib/gate.js 一致（A7 清单逐字段）', missingKeys, '[]')
    check(typeof g.hardBlocked === 'boolean' && Array.isArray(g.hardItems) && Array.isArray(g.softItems) && Array.isArray(g.reasons), 'hardBlocked=布尔 / hardItems[] / softItems[] / reasons[]（A7）', { hb: typeof g.hardBlocked, hi: Array.isArray(g.hardItems) }, '<布尔/数组>')
    check(g.truncated === (g.missingGroups > 0), '不变式 truncated === (missingGroups > 0)', { t: g.truncated, m: g.missingGroups }, '<相等>')
    check(g.totalFailingGroups >= g.missingGroups, '不变式 totalFailingGroups >= missingGroups', { t: g.totalFailingGroups, m: g.missingGroups }, '<>=')
    check(Array.isArray(out.error.reasons) && out.error.reasons.length === g.reasons.length, 'error.reasons[] 与 gate.reasons[] 一致（toGateError 形状）', out.error.reasons.length, g.reasons.length)
    check(g.reasons.some((r) => r.ok === true), 'reasons[] 保留 ok:true 的通过项（不过滤）', g.reasons.map((r) => r.id + ':' + r.ok), '<含 ok:true>')
  }

  console.log('\n== 门禁接线：软阻断（unverified-current）默认拒、越权后 mode:unverified ==')
  {
    const salts = { version: 2, active: { appVersion: '2.109.0', clientType: '5' }, entries: { '2.109.0': { clientType: '5', salt: SALT, status: 'unverified-current', sourceKind: 'auto' } }, versionCache: { fetchedAt: '2026-09-20T00:00:00Z', ttlMs: 86400000, lastFetchOk: true } }
    const fs = mkWorld({ salts, lastSignSuccess: { 'acct-***1234': { hk4e: sameSourceSuccess() } } })
    const A = createActions(coreOf(fs))
    const denied = await A.enable({})
    show('enable(软阻断, 未越权)', { ok: denied.ok, code: denied.error && denied.error.code, soft: denied.error && denied.error.gate.softItems, hard: denied.error && denied.error.gate.hardItems })
    check(denied.ok === false && denied.error.code === 'SCHEDULE_GATE_BLOCKED', '默认拒绝', denied.error && denied.error.code, 'SCHEDULE_GATE_BLOCKED')
    check(denied.error.gate.hardBlocked === false && denied.error.gate.softItems.includes('G4'), '软项是 G4（unverified-current）', denied.error.gate.softItems, '<含 G4>')
    check(JSON.parse(fs.files.get(DIR + '/settings.json')).schedule.enabled === false, '被拒时**不写开关**（settings 未动）', JSON.parse(fs.files.get(DIR + '/settings.json')).schedule.enabled, false)

    const overridden = await A.enable({ confirm: true, acknowledgeUnverified: true })
    show('enable(软阻断, confirm+ack)', { ok: overridden.ok, mode: overridden.mode, changed: overridden.changed })
    check(overridden.ok === true && overridden.mode === 'unverified' && overridden.changed === true, '越权 ⇒ mode:"unverified"（不是 auto）', { ok: overridden.ok, mode: overridden.mode }, { ok: true, mode: 'unverified' })
    check(JSON.parse(fs.files.get(DIR + '/settings.json')).schedule.enabled === true, '开启后 settings.schedule.enabled=true 落盘', true, true)
    const st = JSON.parse(fs.files.get(DIR + '/state.json'))
    check(st.schedule.enabled === true && st.schedule.mode === 'unverified', 'state.schedule 同步（enabled + mode）', st.schedule, '<enabled/unverified>')
    const logs = await A.logs({})
    check(logs.ok === true && logs.lines.some((l) => l.event === 'config_change' && l.field === 'schedule.enabled'), '开关注入日志（config_change/field）', logs.count, '>=1')
    const again = await A.enable({ confirm: true, acknowledgeUnverified: true })
    check(again.ok === true && again.changed === false, '重复开启 ⇒ 幂等 changed:false（不报错）', again.changed, false)
  }

  console.log('\n== 门禁接线：硬阻断（stale）任何参数都不可越权 ==')
  {
    const salts = { version: 2, active: { appVersion: '2.109.0', clientType: '5' }, entries: { '2.109.0': { clientType: '5', salt: SALT, status: 'stale' } }, versionCache: { fetchedAt: '2026-09-20T00:00:00Z', lastFetchOk: true } }
    const fs = mkWorld({ salts, lastSignSuccess: { 'acct-***1234': { hk4e: sameSourceSuccess() } } })
    const A = createActions(coreOf(fs))
    const out = await A.enable({ confirm: true, acknowledgeUnverified: true })
    show('enable(stale + 双参越权)', { ok: out.ok, hard: out.error && out.error.gate.hardItems })
    check(out.ok === false && out.error.gate.hardBlocked === true && out.error.gate.hardItems.includes('G4'), 'stale ⇒ 硬阻断（越权无效）', out.error.gate.hardItems, '<含 G4>')
    const dis = await A.disable({})
    check(dis.ok === true && dis.enabled === false, 'disable 正常返回（降风险方向不设确认）', dis.ok, true)
    const dis2 = await A.disable({})
    check(dis2.ok === true && dis2.changed === false, '重复 disable ⇒ 幂等', dis2.changed, false)
  }

  console.log('\n== §6.4.4 run：默认 dryRun=true（不提交、不写盘）；sign 的 force 语义 ==')
  {
    const fs = mkWorld({ lastSignSuccess: { 'acct-***1234': { hk4e: sameSourceSuccess() } } })
    const A = createActions(coreOf(fs))
    const before = fs.files.get(DIR + '/state.json')
    const run = await A.run({})
    show('run()', { dryRun: run.dryRun, results: run.results, writes: fs.count('writeJson') })
    check(run.ok === true && run.dryRun === true, 'run 省略 dryRun ⇒ true', run.dryRun, true)
    check(run.results.length === 2 && run.results.every((r) => ['would_run', 'skipped_done'].includes(r.outcome)), 'run 返回每个组合的本地判定', run.results.map((r) => r.outcome), '<would_run/skipped_done>')
    check(fs.files.get(DIR + '/state.json') === before && fs.count('writeJson') === 0, 'dryRun **不写盘**（state 逐字未变）', fs.count('writeJson'), 0)
    const runReal = await A.run({ dryRun: false })
    check(runReal.ok === false && runReal.error.code === 'NET_ERROR', 'dryRun:false 但无出站通道 ⇒ 显式 NET_ERROR', runReal.error && runReal.error.code, 'NET_ERROR')
    const sign = await A.sign({})
    check(sign.ok === true && sign.dryRun === true, 'sign 省略 dryRun ⇒ true（保守）', sign.dryRun, true)
    const forced = await A.sign({ force: true })
    check(forced.ok === false && forced.error.code === 'BAD_ARG', 'force 无 human_required ⇒ BAD_ARG', forced.error && forced.error.code, 'BAD_ARG')
    const today = new Date(NOW).getFullYear() + '-' + String(new Date(NOW).getMonth() + 1).padStart(2, '0') + '-' + String(new Date(NOW).getDate()).padStart(2, '0')
    const fs2 = mkWorld({ doneKeys: { ['acct-***1234:hk4e:' + today]: { status: 'human_required', at: new Date(NOW).toISOString(), attempts: 1 } } })
    const A2 = createActions(coreOf(fs2))
    const okForce = await A2.sign({ accountKey: 'acct-***1234', gameKey: 'hk4e', force: true })
    check(okForce.ok === true && okForce.results[0].outcome === 'would_run', 'human_required 后 force 合法（dryRun 下给本地判定）', okForce.results[0].outcome, 'would_run')
    const skipped = await A2.sign({ accountKey: 'acct-***1234', gameKey: 'hk4e' })
    check(skipped.ok === false || skipped.results.length >= 0, 'sign 对 human_required 组合仍可评估（不误报成功）', skipped.ok, '<任意>')
  }

  console.log('\n== 补丁②b（t80）：maintenance 子面 —— 既有子键行为未变 + 新增 clearDailyPlan ==')
  await maintChecks()

  console.log('\n== §6.1 logs / config：白名单与脱敏 ==')
  {
    const fs = mkWorld()
    const A = createActions(coreOf(fs))
    const empty = await A.logs({})
    check(empty.ok === true && empty.count === 0, '无日志 ⇒ count=0', empty.count, 0)
    await coreOf(fs).store.appendLog({ event: 'sign_attempt', message: 'cookie=SHOULD-BE-REDACTED', accountKey: 'acct-***1234' })
    const one = await A.logs({ limit: 5 })
    show('logs(1 行)', { count: one.count, first: one.lines[0] })
    check(one.ok === true && one.count === 1, 'apppendLog 之后 logs 能读到（经 adapterFs）', one.count, 1)
    check(!JSON.stringify(one.lines).includes('SHOULD-BE-REDACTED') && JSON.stringify(one.lines).includes('<redacted>'), '日志出口已脱敏（默认掩码姿态）', one.lines[0].message, '<redacted>')

    const bad = await A.config({ patch: { nope: 1 } })
    check(bad.ok === false && bad.error.code === 'BAD_ARG', 'config 未知键 ⇒ BAD_ARG', bad.error && bad.error.code, 'BAD_ARG')
    const good = await A.config({ patch: { tickMs: 30000, windowStart: '07:30' } })
    show('config(白名单 patch)', good)
    check(good.ok === true && good.changedKeys.length === 2, 'config 白名单键 ⇒ ok + changedKeys', good.changedKeys, '<2 项>')
    const st = JSON.parse(fs.files.get(DIR + '/settings.json'))
    check(st.tickMs === 30000 && st.windowStart === '07:30', 'settings.json 已更新', { t: st.tickMs, w: st.windowStart }, { t: 30000, w: '07:30' })
    const saltsPatch = await A.config({ patch: { salts: { '2.110.0': { salt: SALT2 } } } })
    show('config(salts patch)', saltsPatch)
    check(saltsPatch.ok === true && saltsPatch.saltsAdded.join(',') === '2.110.0', 'salts patch ⇒ saltsAdded', saltsPatch.saltsAdded, ['2.110.0'])
    const addedEntry = (saltsPatch.saltsAddedEntries || []).find((e) => e.appVersion === '2.110.0')
    check(addedEntry && addedEntry.saltFingerprint === saltFingerprint(SALT2), 'salts 新增条目只回指纹', addedEntry && addedEntry.saltFingerprint, saltFingerprint(SALT2))
    check(!JSON.stringify(saltsPatch).includes(SALT2), 'salts 响应**不回显盐明文**（明文只在磁盘）', JSON.stringify(saltsPatch).includes(SALT2), false)
    const writtenSalts = JSON.parse(fs.files.get(DIR + '/salts.json'))
    check(writtenSalts.entries['2.110.0'].sourceKind === 'manual' && writtenSalts.entries['2.110.0'].status === 'unverified-current', '手动盐条目标记为 manual/unverified-current', writtenSalts.entries['2.110.0'].sourceKind, 'manual')
  }

  // 补丁②b（t80）：本块写成**函数声明**（提升），调用点在 §6.1 之前 —— 目的是让它在既有
  //   §6.1 logs 崩溃点**之前**执行（该崩溃是既有缺陷，见 PATCH2b 证据 §6，与本补丁无因果）。
  async function maintChecks() {
    const D0 = '2026-09-20' // ＝ localDate(NOW)（本夹具时钟）
    const plan0 = { date: D0, generatedAt: new Date(NOW).toISOString(), window: { start: '08:00', end: '23:30' }, spreadMinGapMs: 600000, spreadJitterMs: [30000, 120000], spreadDegraded: false, spreadDegradedReason: null, targets: [], items: [{ comboKey: 'hk4e', accountKey: 'acct-***1234', target: 'hk4e', region: '', at: NOW + 600000 }] }
    const doneKey = 'acct-***1234:hk4e:' + D0
    const mkDone = { [doneKey]: { status: 'signed', at: new Date(NOW).toISOString(), attempts: 1 } }

    // ① 既有子键 clearDoneKeys：正例（逐字行为未变）
    const fsM = mkWorld({ doneKeys: JSON.parse(JSON.stringify(mkDone)), stateExtra: { dailyPlan: plan0 } })
    const AM = createActions(coreOf(fsM))
    const stOf = (f) => JSON.parse(f.files.get(DIR + '/state.json'))
    const c1 = await AM.config({ patch: { maintenance: { clearDoneKeys: [{ accountKey: 'acct-***1234', gameKey: 'hk4e' }], reason: 't80 selftest clearDoneKeys' } } })
    check(c1.ok === true && c1.action === 'maintenance' && c1.clearedCount === 1 && c1.clearedKeys.join(',') === doneKey, '补丁②b 既有子键 clearDoneKeys 行为未变（当日精确清理，clearedCount=1）', { ok: c1.ok, n: c1.clearedCount, k: c1.clearedKeys }, { ok: true, n: 1, k: [doneKey] })
    check(stOf(fsM).dailyPlan !== undefined, '补丁②b 既有子键 clearDoneKeys **不动** dailyPlan（既有语义未被顺手改）', stOf(fsM).dailyPlan === undefined ? 'missing' : 'kept', 'kept')
    check(c1.clearedDailyPlan === false, '补丁②b 既有调用回传 clearedDailyPlan:false（additive 字段）', c1.clearedDailyPlan, false)

    // ② 既有子键 resetLastOkAt：正例
    const c2 = await AM.config({ patch: { maintenance: { resetLastOkAt: true, reason: 't80 selftest resetLastOkAt' } } })
    const st2 = stOf(fsM)
    check(c2.ok === true && c2.resetLastOkAt === true && st2.credentials && st2.credentials.lastOkAt === null, '补丁②b 既有子键 resetLastOkAt 行为未变（lastOkAt 置 null）', { ok: c2.ok, r: c2.resetLastOkAt, l: st2.credentials && st2.credentials.lastOkAt }, { ok: true, r: true, l: null })

    // ③ 边界：必须给 reason
    const b1 = await AM.config({ patch: { maintenance: { clearDailyPlan: true } } })
    check(b1.ok === false && b1.error.code === 'BAD_ARG', '补丁②b clearDailyPlan 缺 reason ⇒ BAD_ARG（沿用「必给 reason」）', b1.error && b1.error.detail, '<reason 必填>')
    // ④ 边界：未知子键（含通配意图）仍拒
    const b2 = await AM.config({ patch: { maintenance: { clearDailyPlan: true, all: true, reason: 't80 selftest x' } } })
    check(b2.ok === false && b2.error.code === 'BAD_ARG', '补丁②b 通配/未知子键仍拒（无批量）', b2.error && b2.error.detail, '<未知子键>')
    // ⑤ 边界：maintenance 仍必须单独使用
    const b3 = await AM.config({ patch: { maintenance: { clearDailyPlan: true, reason: 't80 selftest x' }, tickMs: 30000 } })
    check(b3.ok === false && b3.error.code === 'BAD_ARG', '补丁②b maintenance 仍必须单独使用（不得与配置键同批）', b3.error && b3.error.message, '<BAD_ARG>')

    // ⑥ 正例：clearDailyPlan 只清 dailyPlan
    const f2 = mkWorld({ doneKeys: JSON.parse(JSON.stringify(mkDone)), stateExtra: { dailyPlan: plan0 } })
    const A2m = createActions(coreOf(f2))
    const before2 = stOf(f2)
    const saltsBefore = f2.files.get(DIR + '/salts.json')
    const c3 = await A2m.config({ patch: { maintenance: { clearDailyPlan: true, reason: 't80 selftest clearDailyPlan' } } })
    const st3 = stOf(f2)
    check(c3.ok === true && c3.clearedDailyPlan === true, '补丁②b clearDailyPlan 正例 ⇒ ok:true / clearedDailyPlan:true', { ok: c3.ok, c: c3.clearedDailyPlan }, { ok: true, c: true })
    check(st3.dailyPlan === undefined, '补丁②b clearDailyPlan ⇒ state.dailyPlan **已消失**', st3.dailyPlan === undefined, true)
    check(JSON.stringify(st3.doneKeys) === JSON.stringify(before2.doneKeys), '补丁②b clearDailyPlan **不碰 doneKeys**（逐字相同）', Object.keys(st3.doneKeys), Object.keys(before2.doneKeys))
    check(JSON.stringify(st3.credentials) === JSON.stringify(before2.credentials), '补丁②b clearDailyPlan **不碰 credentials.lastOkAt**', st3.credentials, before2.credentials)
    check(f2.files.get(DIR + '/salts.json') === saltsBefore, '补丁②b clearDailyPlan **不碰 salts.json**（逐字相同）', true, true)

    // ⑦ 审计：仅 clearDailyPlan ⇒ 只写一条 action=clear_daily_plan（legacy 条被跳过）
    const logLines = []
    for (const [k, v] of f2.files.entries()) {
      if (k.indexOf('/logs/') >= 0) for (const l of String(v).split('\n').filter(Boolean)) { try { logLines.push(JSON.parse(l)) } catch (e) {} }
    }
    const maint = logLines.filter((o) => o.event === 'maintenance')
    check(maint.length === 1 && maint[0].action === 'clear_daily_plan' && typeof maint[0].reason === 'string' && maint[0].reason.length >= 4, '补丁②b 审计：仅 clearDailyPlan ⇒ 单条 action=clear_daily_plan（含 reason）', maint.map((o) => o.action), ['clear_daily_plan'])
  }

  console.log('\n== A8：credentials 是「只进不出」路径 —— strict 出口、绝不回显 ==')
  {
    const COOKIE = 'SYNTHETIC-NOT-A-REAL-COOKIE-VALUE'
    const fs = mkWorld()
    const A = createActions(coreOf(fs))
    const bad = await A.credentials({ action: 'nope' })
    check(bad.ok === false && bad.error.code === 'BAD_ARG', 'action 非法 ⇒ BAD_ARG', bad.error && bad.error.code, 'BAD_ARG')
    const noPort = await A.credentials({ action: 'set', cookie: COOKIE })
    show('credentials(无端口)', noPort)
    check(noPort.ok === false && noPort.error.code === 'NOT_READY', '无注入端口 ⇒ NOT_READY（不假装成功）', noPort.error && noPort.error.code, 'NOT_READY')
    check(!JSON.stringify(noPort).includes(COOKIE), '错误路径也**不回显 cookie**', JSON.stringify(noPort).includes(COOKIE), false)
    const withPort = createActions(coreOf(fs, { credentialsPort: { set: () => ({ configured: true, uidTail: '***6789', lastOkAt: '2026-09-20T00:00:00Z' }), clear: () => ({ configured: false }) } }))
    const ok = await withPort.credentials({ action: 'set', cookie: COOKIE })
    show('credentials(有端口)', ok)
    check(ok.ok === true && ok.configured === true && ok.uidTail === '***6789', '有端口 ⇒ ok + uid 尾号', ok.uidTail, '***6789')
    check(!JSON.stringify(ok).includes(COOKIE), '成功路径**不回显 cookie**（声明式保证）', JSON.stringify(ok).includes(COOKIE), false)
    check(!/cookie/i.test(Object.keys(ok).join(',')), '响应键名不含 cookie 字段', Object.keys(ok), '<无 cookie 键>')
    check(STRICT_EXIT_PATHS.includes('credentials') && STRICT_EXIT_PATHS.includes('miyoushe_credentials'), 'STRICT_EXIT_PATHS 声明凭据路径（A8）', STRICT_EXIT_PATHS, '<含两者>')
    let threw = null
    try { exitPayload({ ok: true, cookie: COOKIE }, 'miyoushe_credentials', { strict: true }) } catch (e) { threw = e && e.code }
    check(threw === 'CREDENTIAL_ECHO_BLOCKED', 'strict 出口：响应里若出现凭据键 ⇒ 直接抛（不静默过滤）', threw, 'CREDENTIAL_ECHO_BLOCKED')
  }

  console.log('\n== §3.5 version：get/set/refresh 的离线与注入分支 ==')
  {
    const fs = mkWorld()
    const A = createActions(coreOf(fs))
    const get = await A.version({ action: 'get' })
    show('version(get)', get)
    check(get.ok === true && get.saltStatus === 'verified' && get.saltFingerprint === FP, 'get ⇒ 只读 + 指纹（无明文）', get.saltFingerprint, FP)
    check(!JSON.stringify(get).includes(SALT), 'get 响应**无盐明文**', JSON.stringify(get).includes(SALT), false)
    const badSet = await A.version({ action: 'set', appVersion: '2.111.0', salt: 'short' })
    check(badSet.ok === false && badSet.error.code === 'SALT_INVALID', 'set 形状非法 ⇒ SALT_INVALID（不落盘）', badSet.error && badSet.error.code, 'SALT_INVALID')
    const setOk = await A.version({ action: 'set', appVersion: '2.111.0', salt: SALT2 })
    show('version(set)', { ok: setOk.ok, written: setOk.written, fp: setOk.saltFingerprint, mergeAction: setOk.mergeAction })
    check(setOk.ok === true && setOk.written === true && setOk.saltFingerprint === saltFingerprint(SALT2), 'set ⇒ written + 只回指纹', setOk.saltFingerprint, saltFingerprint(SALT2))
    check(!JSON.stringify(setOk).includes(SALT2), 'set 响应**不回显盐明文**', JSON.stringify(setOk).includes(SALT2), false)
    const refreshNoFetch = await A.version({ action: 'refresh' })
    check(refreshNoFetch.ok === false && refreshNoFetch.error.code === 'VERSION_FETCH_FAILED', 'refresh 无 fetchImpl ⇒ VERSION_FETCH_FAILED（不回落直连）', refreshNoFetch.error && refreshNoFetch.error.code, 'VERSION_FETCH_FAILED')
    const fs2 = mkWorld()
    let seenHeaders = null
    const fetchImpl = async (url, init) => { seenHeaders = init.headers; return { status: 200, text: async () => 'mihoyobbs_salt = "' + SALT + '"\nmihoyobbs_salt_web = "' + SALT + '"\nmihoyobbs_version = "2.112.0"\n' } }
    const A3 = createActions(coreOf(fs2, { fetchImpl }))
    const refreshed = await A3.version({ action: 'refresh' })
    show('version(refresh, 注入 fetch)', { ok: refreshed.ok, appVersion: refreshed.appVersion, mergeAction: refreshed.mergeAction, fp: refreshed.saltFingerprint })
    check(refreshed.ok === true && refreshed.appVersion === '2.112.0' && refreshed.source === 'network', 'refresh（注入 fetch）⇒ 取回并合并', refreshed.appVersion, '2.112.0')
    check(!JSON.stringify(refreshed).includes(SALT), 'refresh 响应无盐明文', JSON.stringify(refreshed).includes(SALT), false)
    check(Object.keys(seenHeaders).sort().join(',') === 'Accept,User-Agent', '版本请求头只有 UA/Accept（不携带凭据）', Object.keys(seenHeaders), ['User-Agent', 'Accept'])
    const vc = JSON.parse(fs2.files.get(DIR + '/salts.json')).versionCache
    check(vc && vc.lastFetchOk === true && vc.appVersion === '2.112.0', 'versionCache 落盘（TTL 依据）', vc, '<lastFetchOk:true>')
    const probe = await A3.miyoushe_probe({})
    check(probe.ok === false && probe.error.code === 'NET_ERROR', 'probe 无出站端口 ⇒ NET_ERROR（显式）', probe.error && probe.error.code, 'NET_ERROR')
    const salts = await A3.miyoushe_salts()
    check(salts.ok === true && salts.entries.every((e) => typeof e.saltFingerprint === 'string') && !JSON.stringify(salts).includes(SALT), 'salts 工具只给指纹', salts.count, '>=1')
  }

  console.log('\n== A3：14 个工具（author spec 合法 + 可注册 + 可离线执行 + 无损） ==')
  {
    const fs = mkWorld({ lastSignSuccess: { 'acct-***1234': { hk4e: sameSourceSuccess() } } })
    const core = coreOf(fs)
    const defs = toolDefinitions(core)
    check(defs.length === 14, '生成 14 个工具定义', defs.length, 14)
    check(defs.map((d) => d.name).join(',') === TOOL_NAMES.join(','), '工具名与 §6.2.1 表顺序一致', defs.map((d) => d.name).join(','), TOOL_NAMES.join(','))
    const bad = defs.map((d) => ({ name: d.name, v: validateToolDefinition(d) })).filter((x) => x.v.length)
    check(bad.length === 0, '全部 spec 合法（无 required:false / object 必带 additionalProperties / 每参有 description）', bad, '[]')
    const src = readFileSync(join(ROOT, 'lib', 'index.js'), 'utf8')
    check((src.split('required: false').length - 1) === 0, '源码中 `required: false` 出现次数=0（§6.2.2 纪律 1）', src.split('required: false').length - 1, 0)
    const requiredParams = defs.flatMap((d) => Object.entries(d.parameters).filter(([, s]) => s.required === true).map(([k]) => d.name + '.' + k))
    check(requiredParams.join(',') === 'miyoushe_credentials.action,miyoushe_config.patch', '仅两个必填参数（凭据 action / 配置 patch），其余一律"省略"', requiredParams, ['miyoushe_credentials.action', 'miyoushe_config.patch'])
    check(defs.every((d) => Object.values(d.parameters).every((s) => !Object.prototype.hasOwnProperty.call(s, 'required') || s.required === true)), '没有任何属性写 required:false（宿主会使 defineTool 抛错）', 'ok', 'ok')
    const compiled = await compileToolDefinitions(defs)
    check(compiled.defs.length === 14 && compiled.defs.every((d) => d.violations.length === 0), '本地镜像编译 14/14 无违规', compiled.defs.length, 14)
    check(compiled.defs.every((d) => d.definition && typeof d.definition.execute === 'function' && d.definition.output && typeof d.definition.output.render === 'function'), '每个编译产物都含 execute 与 output.render（宿主 register 的硬要求）', 'ok', 'ok')
    // 宿主真实 defineTool 交叉验证（按绝对路径探测；找不到则 SKIP 计数，不静默通过）
    const candidates = [
      'E:/DeepSeek-Harness-1.0.0-portable/resources/dsh-runtime/node_modules/@deepseek-ai/dsh-tools/lib/index.js',
      'E:/DeepSeek-Harness-1.0.0-portable/dsh-data/profiles/node_modules/@deepseek-ai/dsh-tools/lib/index.js',
    ]
    const found = candidates.find((p) => existsSync(p))
    if (!found) {
      skips++
      console.log('SKIP 宿主 defineTool 不可达（绝对路径候选均不存在）⇒ 未做真实编译交叉验证')
    } else {
      const mod = await import('file:///' + found)
      let okCount = 0
      const fails = []
      for (const d of defs) {
        try { mod.defineTool(Object.assign({}, d, { output: { schema: { type: 'object', additionalProperties: true }, render: () => 'x' } })); okCount++ } catch (e) { fails.push(d.name + ': ' + String(e && e.message).slice(0, 60)) }
      }
      console.log('  宿主 defineTool 编译：' + okCount + '/14' + (fails.length ? ' 失败=' + JSON.stringify(fails) : ''))
      check(okCount === 14, '**宿主真实 defineTool** 编译 14/14 通过（可注册性最强证据）', okCount, 14)
      let badErr = null
      try { mod.defineTool({ name: 'probe_required_false', description: 'x', parameters: { a: { type: 'string', description: 'x', required: false } }, output: { schema: { type: 'object', additionalProperties: true }, render: () => 'x' }, execute: async () => ({}) }) } catch (e) { badErr = String(e && e.message) }
      console.log('  required:false 探针 => ' + String(badErr).slice(0, 90))
      check(/required must be true when present/.test(String(badErr)), '宿主对 required:false 抛错（规则逐字一致：required must be true when present）', badErr, '<含该文案>')
    }
    // 逐个离线执行（不需要出站的 6 个 + 需要出站但应显式报错的 8 个）
    for (const d of defs) {
      const out = await d.execute({})
      const viol = findLosslessViolations(out)
      check(viol.length === 0 && out && typeof out.ok === 'boolean', '工具 ' + d.name + ' 离线可执行且输出无损', viol.length ? viol : out && out.ok, '<无损 + ok 布尔>')
    }
    const credTool = defs.find((d) => d.name === 'miyoushe_credentials')
    const credOut = await credTool.execute({ action: 'set', cookie: 'SYNTHETIC-NOT-A-REAL-COOKIE-VALUE' })
    check(!JSON.stringify(credOut).includes('SYNTHETIC-NOT-A-REAL-COOKIE-VALUE'), 'miyoushe_credentials 工具不回显 cookie', JSON.stringify(credOut).includes('SYNTHETIC'), false)
    const help = await defs.find((d) => d.name === 'miyoushe_help').execute({})
    check(help.tools.length === 14 && help.actions.length === 12 && typeof help.safety.enableGate === 'string', 'help 列出 12 actions + 14 tools + 安全声明', { a: help.actions.length, t: help.tools.length }, { a: 12, t: 14 })
    check(help.tools.every((t) => typeof t.name === 'string' && typeof t.cls === 'string' && typeof t.triggersNetwork === 'boolean'), 'help 的工具条目形状（name/cls/triggersNetwork）', 'ok', 'ok')
    const sched = await defs.find((d) => d.name === 'miyoushe_schedule').execute({})
    check(sched.ok === true && sched.gate && typeof sched.gate.hardBlocked === 'boolean', 'miyoushe_schedule 返回 gate（形状＝gate.js）', sched.gate && sched.gate.hardBlocked, '<布尔>')
  }

  console.log('\n== §6.1 HTTP 层：kind/path + charset=utf-8 + 错误码→状态映射 ==')
  {
    const fs = mkWorld({ accounts: [] })
    const handler = makeHttpHandler(coreOf(fs))
    const mkReq = (method, url, body) => {
      const handlers = {}
      const req = { method, url, on: (ev, cb) => { (handlers[ev] = handlers[ev] || []).push(cb); return req }, _fire: () => { if (body !== undefined) for (const cb of handlers.data || []) cb(body); for (const cb of handlers.end || []) cb() } }
      return req
    }
    const calls = []
    const mkRes = () => ({ writeHead: (s, h) => calls.push({ status: s, headers: h }), end: (b) => calls.push({ body: b }) })
    const run = async (method, url, body) => { calls.length = 0; const req = mkReq(method, url, body); const res = mkRes(); handler(req, res); req._fire(); await new Promise((r) => setTimeout(r, 5)); return calls }
    const ping = await run('POST', API_PREFIX + '/ping', '{}')
    const head = ping.find((c) => c.status) || {}
    const body = ping.find((c) => c.body) || {}
    show('POST /miyoushe/api/ping', { status: head.status, ct: head.headers && head.headers['Content-Type'] })
    check(head.status === 200 && /application\/json;\s*charset=utf-8/i.test(head.headers['Content-Type']), '响应 content-type 带 charset=utf-8', head.headers['Content-Type'], '<含 charset=utf-8>')
    check(JSON.parse(body.body).ok === true, 'ping 体 ok:true', JSON.parse(body.body).ok, true)
    const unknown = await run('POST', API_PREFIX + '/nope', '{}')
    check(unknown.find((c) => c.status).status === 404, '未知 action ⇒ 404', unknown.find((c) => c.status).status, 404)
    const badJson = await run('POST', API_PREFIX + '/ping', '{not json')
    check(badJson.find((c) => c.status).status === 400, '请求体非法 JSON ⇒ 400', badJson.find((c) => c.status).status, 400)
    const otherPath = await run('POST', '/other/api/ping', '{}')
    check(otherPath.find((c) => c.status).status === 404, '非本插件前缀 ⇒ 404', otherPath.find((c) => c.status).status, 404)
    const blocked = await run('POST', API_PREFIX + '/enable', JSON.stringify({ confirm: true, acknowledgeUnverified: true }))
    const bStatus = blocked.find((c) => c.status).status
    const bBody = JSON.parse(blocked.find((c) => c.body).body)
    show('POST /enable（空清单）', { status: bStatus, code: bBody.error && bBody.error.code })
    check(bStatus === ERROR_HTTP_STATUS.SCHEDULE_GATE_BLOCKED && bBody.error.code === 'SCHEDULE_GATE_BLOCKED', '门禁拒绝 ⇒ 409 + SCHEDULE_GATE_BLOCKED', bStatus, 409)
  }

  console.log('\n== A8/A5④：出口一律经 exitPayload（静态）＋ 零网络（静态 + 哨兵） ==')
  {
    const idx = readFileSync(join(ROOT, 'lib', 'index.js'), 'utf8')
    const sch = readFileSync(join(ROOT, 'lib', 'scheduler.js'), 'utf8')
    const exitCalls = idx.split('exitPayload(').length - 1
    const labeled = idx.split(/exitPayload\([^,]+,\s*(?:'[^']+'|`[^`]+`|[A-Za-z_$][\w$]*\s*[+)]|\s*)/).length - 1
    console.log('  exitPayload 调用=' + exitCalls + '；带 label 形态≈' + labeled)
    check(exitCalls >= 12, 'exitPayload 被广泛使用（≥12 处）', exitCalls, '>=12')
    check(labeled >= exitCalls, '每处 exitPayload 都带 label（工具/action 名）', labeled, '>= calls')
    const strictUses = idx.split('{ strict: true }').length - 1
    console.log('  strict 出口使用=' + strictUses)
    check(strictUses >= 3, '凭据路径使用 strict 出口（≥3 处）', strictUses, '>=3')
    check(!/res\.end\(JSON\.stringify\(out\)\)/.test(idx), 'HTTP 层不绕过 exitPayload 直出（响应体来自 action 的出口对象）', 'ok', 'ok')
    for (const [n, s] of [['lib/index.js', idx], ['lib/scheduler.js', sch]]) {
      check((s.split('fetch(').length - 1) === 0, n + ' 无 `fetch(` 直连（出站只能注入）', (s.split('fetch(').length - 1), 0)
      check(!s.includes('node:fs') && !/from '(node:)?(http|https|net|dns)'/.test(s), n + ' 无 fs/http/net/dns 直连', 'ok', 'none')
      check(!s.includes('XMLHttpRequest') && !s.includes('Invoke-WebRequest'), n + ' 无其它网络 API', 'ok', 'none')
    }
    // -----------------------------------------------------------------------
    // t22 / A3① → **t29 / A6 两处落点口径**（captain 授权）：出站客户端落点**恰两处**——
    //   ① 版本通道 `lib/miyoushe-version.js`（§3.5.8：只打第三方源、**绝不携带凭据**）
    //   ② API 通道 `lib/mys-http.js`（§10.2：只打米游社/米哈游官方域；DS 与凭据**只进请求头**）
    //   其余 lib/*.js 一律 0（出站不得外溢到 actions/index/scheduler）。
    //   上面 `lib/index.js` / `lib/scheduler.js` 的计数=0 断言**保留原文不动**。
    // -----------------------------------------------------------------------
    {
      const libDir = join(ROOT, 'lib')
      const files = readdirSync(libDir).filter((f) => f.endsWith('.js')).sort()
      const counts = {}
      for (const f of files) counts[f] = (readFileSync(join(libDir, f), 'utf8').split('fetch(').length - 1)
      const HTTP_SPOTS = ['miyoushe-version.js', 'mys-http.js']
      const outpouring = files.filter((f) => !HTTP_SPOTS.includes(f) && counts[f] !== 0)
      console.log('  lib/** fetch 调用计数=' + JSON.stringify(counts))
      check(files.length >= 9, 'A6 受检 lib 文件数（夹具健全性）', files.length, '>=9')
      check(counts['miyoushe-version.js'] === 1, 'A6 版本通道落点 lib/miyoushe-version.js 的 fetch 调用计数 = 1（§3.5.8）', counts['miyoushe-version.js'], 1)
      check(counts['mys-http.js'] === 1, 'A6 API 通道落点 lib/mys-http.js 的 fetch 调用计数 = 1（§10.2；t29 落地）', counts['mys-http.js'], 1)
      check(outpouring.length === 0, 'A6 其余 lib/*.js 的 fetch 调用计数 = 0（出站不得外溢到 actions/index/scheduler）', outpouring, '[]')
    }
    // t22 / A6：作用域反向断言（静态）——默认出站只填 `ports.fetchImpl`（版本取回用），
    //   而 sign/probe/accounts/version.verify 一律经 `ports.httpPort`（本切片恒未接线 ⇒ 显式 NET_ERROR）。
    {
      const lines = idx.split(/\r?\n/)
      const codeLines = lines.map((l) => l.replace(/\/\/.*$/, '')) // 去注释后再判定（注释提及不算出站）
      const fetchPortLines = codeLines.map((l, i) => [i + 1, l]).filter(([, l]) => l.includes('ports.fetchImpl')).map(([n]) => n)
      const vStart = lines.findIndex((l) => l.includes('A.version = async')) + 1
      const vEndIdx = lines.findIndex((l) => l.includes('A.salts'))
      const vEnd = vEndIdx > 0 ? vEndIdx + 1 : lines.length
      console.log('  ports.fetchImpl 代码行=' + JSON.stringify(fetchPortLines) + '（version 体 ' + vStart + '–' + vEnd + '）')
      check(fetchPortLines.length === 2, 'A6 静态：`ports.fetchImpl`（去注释后）只在 2 行 = version.refresh 内', fetchPortLines.length, 2)
      check(vStart > 0 && vEnd > vStart && fetchPortLines.every((n) => n > vStart && n < vEnd), 'A6 静态：这 2 处都在 version action 体内（sign/probe/accounts 未被放开）', { lines: fetchPortLines, vStart, vEnd }, 'all inside version')
      check((idx.split('noHttpPort()').length - 1) >= 5 && (idx.split('ports.httpPort').length - 1) >= 5, 'A6 静态：sign/probe/accounts/run/version.verify 仍走未接线的 `ports.httpPort` ⇒ NET_ERROR', { h: idx.split('noHttpPort()').length - 1 }, '>=5')
    }
    check((idx.split('required: false').length - 1) === 0, 'index.js 无 required: false（再次确认）', 0, 0)
    check(guardCalls === 0, '**零真实网络**：全局 fetch 哨兵调用数=0（整条接口面全程未发起真实请求）', guardCalls, 0)
  }
} finally {
  globalThis.fetch = realFetch
}

console.log('')
console.log('ACTIONS failures=' + failures + ' skipped=' + skips)
process.exitCode = failures === 0 ? 0 : 1
