// @local/miyoushe —— t31 套件：凭据读取 → sign 真实提交 → 盐升级 → accounts 映射（**全离线**）
// 运行：node selftest/sign_path.mjs      （退出码 0 = 全过）
//
// 覆盖（t31 S1–S5）：
//   S1 凭据读取（只读、只进不出）：`store.readCredentials()` 结构 + 任何出口都不回显凭据值
//   S2 `sign{dryRun:false}` 全链路（真 mys-http + 假 transport）：方法/路径/头（含凭据与 DS）/白名单/限速
//      + 四条 outcome（signed / already / human_required / failed）+ force 语义 + doneKeys/lastOutcome
//   S3 首次成功 ⇒ 盐条目 unverified-current → verified（verifiedAt 非空）+ active 非空
//   S4 `accounts{refresh:true}`：data.list → accounts[{accountKey,uidTail,roles}]，**并落盘** accounts.json（t38 起）
//   S5 `miyoushe_help.safety.outbound` 文案：API 通道「已实现」、第三方源仅版本通道且不带凭据
//
// t38 增补（A1–A5/A7）· t41 回灌：
//   A1 写入通道：refresh 成功 ⇒ `全局数据/miyoushe/accounts.json` 落盘（`persisted:true` + 本机路径）
//   A2 形状 `{version:1, updatedAt:<ISO>, accounts:[{accountKey,uid,roles:[{gameKey,region,gameUid,nickname?,level?}]}]}`；
//      文件缺失 ⇒ 空骨架（不抛）；读回与落盘**逐字一致**
//   A4 落盘**保留原值**（本机数据面：完整 uid/region）；**出口**逐字无完整 uid、无凭据值（只给尾号）
//   A5 `groupsFromAccounts(readAccounts(), settings)` 组合数 = 角色数 ⇒ sign 不再「无待处理组合」
//   A7 `accounts.json` 原文无凭据位/无凭据值
//
// t41 新增（F1/F2/F3）：
//   F1 `miyoushe_config` 的 `schedule` 段形状校验 + fail-closed 拒绝（颠倒区间**不夹取**）+ 缺省补齐
//   F2 `miyoushe_schedule` 出口暴露 `spread`（minGap/jitter/targets）与 `dailyPlan`（不含 uid）
//   F3 `A.sign`/`A.run` 的 region 感知 4 段去重键（同账号 bh3 三区服 ⇒ 3 个互不相同的键）
//
// 纪律：凭据一律**假值**（`SYNTHETIC-NOT-A-REAL-CREDENTIAL-t31`）；盐为**运行时生成** 32 位 hex（不落字面量）；
//       全程 `globalThis.fetch` 哨兵调用数 = 0（真 mys-http 只走注入的假 transport）。

import { createHash } from 'node:crypto'
import { createCore, createActions, groupsFromAccounts, mapDiscoveredRoles, readAccountsFile, writeAccountsFile, persistAccounts, bizKey, SPREAD_DEFAULTS, signRequestPlan, targetSelected, filterGroupsForTargets, bizOfGameKey, withAuthOk, writeCredentialToStore, clearCredentialInStore, backfillSameSaltSuccess, validateMaintenance, credentialConfiguredOf, uidFromCredentialString } from '../lib/index.js'
import { targetSelected as schedTargetSelected } from '../lib/scheduler.js'
import { createHttpPort } from '../lib/mys-http.js'
import { dedupeKey, localDateOf } from '../lib/scheduler.js'
import { saltFingerprint } from '../lib/mask.js'

let failures = 0
function check(cond, label, got, want) {
  if (cond) console.log('PASS ' + label)
  else { failures++; console.log('FAIL ' + label + ' got=' + JSON.stringify(got) + ' want=' + JSON.stringify(want)) }
}

const DATA_ROOT = 'E:/DSH工作区/全局数据'
const DIR = DATA_ROOT + '/miyoushe'
const FAKE_CRED = 'SYNTHETIC-NOT-A-REAL-CREDENTIAL-t31' // 假凭据（绝不是真实 Cookie）
const SALT32 = createHash('sha256').update('t31-sign-path-fixture').digest('hex').slice(0, 32)

/** 内存版 adapterFs 假体（对外方法子集同 AdapterFsImpl） */
class MemAdapterFs {
  constructor(files, dirs) {
    this.roots = { 全局数据: DATA_ROOT }
    this.dirs = new Set(dirs || [DIR, DIR + '/logs'])
    this.files = new Map(Object.entries(files || {}))
    this.calls = []
  }
  _p(root, rel) { const base = this.roots[root]; if (base === undefined) { const e = new Error('unknown root'); e.code = 'ROOT_UNKNOWN'; throw e } return rel ? base + '/' + rel : base }
  _rec(op, rel) { this.calls.push({ op, rel }) }
  async resolve(root, rel) { const p = this._p(root, rel); return { targetKey: p, displayPath: p } }
  async exists(root, rel) { this._rec('exists', rel); const p = this._p(root, rel); return this.dirs.has(p) || this.files.has(p) }
  async readText(root, rel) { this._rec('readText', rel); const p = this._p(root, rel); if (!this.files.has(p)) { const e = new Error('not found'); e.code = 'FS_NOT_FOUND'; throw e } return this.files.get(p) }
  async readJson(root, rel) { this._rec('readJson', rel); const t = await this.readText(root, rel); try { return JSON.parse(t) } catch (e) { const err = new Error('bad json'); err.code = 'EBADJSON'; throw err } }
  async writeText(root, rel, text) { this._rec('writeText', rel); this.files.set(this._p(root, rel), text); return { ok: true, operation: 'update' } }
  async writeJson(root, rel, data) { this._rec('writeJson', rel); this.files.set(this._p(root, rel), JSON.stringify(data, null, 2)); return { ok: true, operation: 'update' } }
  async listDir() { return [] }
}

const CRED_FILE = JSON.stringify({
  version: 1, updatedAt: '2026-09-20T04:00:00Z',
  accounts: [{ accountKey: 'acct-***4321', credential: FAKE_CRED, uid: '10004321', createdAt: '2026-09-20T04:00:00Z', lastOkAt: null }],
})
const ENDPOINT_TABLE = JSON.stringify({
  version: 1, updatedAt: '2026-09-20T04:00:00Z',
  endpoints: {
    hk4e: { host: 'api-takumi.mihoyo.com', signPath: '/event/luna/sign', actId: 'e202311201442471', query: { lang: 'zh-cn' } },
    bh3: { host: 'api-takumi.mihoyo.com', signPath: '/event/luna/bh3/sign', actId: 'e202306201626331' },
  },
})
const mkSalts = (status, material, active) => JSON.stringify({
  version: 2, updatedAt: '2026-09-20T04:00:00Z',
  // 默认带 active（可签名）；显式传 null 可复现「active 缺失 ⇒ SALT_MISSING」
  active: active === undefined ? { appVersion: '2.109.0', clientType: '5' } : active,
  entries: { '2.109.0': { clientType: '5', salt: material, saltFingerprint: 'deadbeef', status, sourceKind: 'auto', fetchedAt: '2026-09-20T03:00:00Z', verifiedAt: null } },
  versionCache: { appVersion: '2.109.0', clientType: '5', lastFetchOk: true, fetchedAt: '2026-09-20T03:00:00Z', ttlMs: 86400000 },
})
const ACCOUNTS_FILE = JSON.stringify({
  version: 1, updatedAt: '2026-09-20T04:00:00Z',
  accounts: [{ accountKey: 'acct-***4321', uid: '10004321', roles: [{ gameKey: 'hk4e', target: 'hk4e' }] }],
})
const SETTINGS_FILE = JSON.stringify({ version: 1, tickMs: 60000, windowStart: '08:00', windowEnd: '23:30', bbsEnabled: false })
const STATE_EMPTY = JSON.stringify({ version: 1, schedule: { enabled: false, mode: 'readonly', nextAt: null, lastRunAt: null, pausedBy: null }, doneKeys: {}, lastSignSuccess: {}, lock: null })

function mkFs(over) {
  const files = { [DIR + '/settings.json']: SETTINGS_FILE, [DIR + '/state.json']: STATE_EMPTY, [DIR + '/logs/.keep']: '' }
  return new MemAdapterFs(Object.assign(files, over || {}))
}
function fakeClock(startMs) {
  const st = { nowMs: startMs, sleeps: [] }
  return { st, now: () => st.nowMs, sleep: async (ms) => { st.sleeps.push(ms); st.nowMs += ms } }
}
function capturingTransport(script) {
  const calls = []
  const t = async (url, init) => {
    calls.push({ url, init })
    const step = script[Math.min(calls.length - 1, script.length - 1)]
    if (step && step.throw) { const e = new Error('boom'); if (step.throw.name) e.name = step.throw.name; throw e }
    return { status: step.status === undefined ? 200 : step.status, text: async () => (step.body === undefined ? '{"retcode":0,"message":"OK","data":{}}' : step.body) }
  }
  return { t, calls }
}
/** 用真 mys-http + 假 transport 组装 core+actions（sign/accounts 走的就是生产代码路径） */
function mkCore(fs, over) {
  const o = over || {}
  const port = createHttpPort({
    transport: o.transport, salts: o.salts === undefined ? null : o.salts, credential: o.credential === undefined ? FAKE_CRED : o.credential,
    now: o.now, sleep: o.sleep, r: o.r,
  })
  const core = createCore({ adapterFs: fs, httpPort: port, now: () => (o.nowMs === undefined ? 1700000000000 : o.nowMs), version: '0.1.0' })
  // 与 `apply` 同款接线：端口经 store 读 salts（生产路径一致）
  if (typeof port.bindStore === 'function') port.bindStore(core.store)
  const A = createActions(core)
  return { core, A, port }
}
const getFile = (fs, name) => JSON.parse(fs.files.get(DIR + '/' + name))
/** 造一份带指定旧 3 段 `doneKeys` 的 state.json（**兼容读**断言用：证明升级前遗留记录仍能被读到） */
const jsonStateWithDoneKey = (key, entry) => JSON.stringify({
  version: 1,
  schedule: { enabled: false, mode: 'readonly', nextAt: null, lastRunAt: null, pausedBy: null },
  doneKeys: { [key]: entry },
  lastSignSuccess: {},
  lock: null,
})

console.log('== S1 凭据读取（只读、只进不出） ==')
{
  const fsMissing = mkFs({})
  const { core: c0, A: A0 } = mkCore(fsMissing, { salts: JSON.parse(mkSalts('verified', SALT32)) })
  check(await c0.store.readCredentials() === null, 'S1 凭据文件缺失 ⇒ readCredentials() = null', 'null', null)

  const fsEmpty = mkFs({ [DIR + '/credentials.json']: '{"version":1,"accounts":[]}' })
  const { core: c1, A: A1x } = mkCore(fsEmpty, { salts: JSON.parse(mkSalts('verified', SALT32)) })
  const empty = await c1.store.readCredentials()
  check(empty && empty.accounts.length === 0 && empty.primary === null, 'S1 空 accounts ⇒ 结构化返回（primary=null，不编造）', empty && { n: empty.accounts.length, p: empty.primary }, { n: 0, p: null })

  const fsCred = mkFs({ [DIR + '/credentials.json']: CRED_FILE })
  const { core: c2, A: A2x } = mkCore(fsCred, { salts: JSON.parse(mkSalts('verified', SALT32)) })
  const file = await c2.store.readCredentials()
  check(file && file.primary && file.primary.credential === FAKE_CRED, 'S1 合法文件 ⇒ primary.credential 逐字等于文件值（**假值**）', file && file.primary && file.primary.credential, FAKE_CRED)
  check(file.primary.accountKey === 'acct-***4321' && file.primary.uid === '10004321', 'S1 身份字段（accountKey/uid）按定形格式解出', { k: file.primary.accountKey, u: file.primary.uid }, { k: 'acct-***4321', u: '10004321' })
  check(fsCred.calls.filter((x) => x.op === 'readJson' && x.rel === 'miyoushe/credentials.json').length === 1, 'S1 读取经 adapterFs.readJson（§10.1，无裸 fs）', fsCred.calls.length, '>=1')

  // 出口不回显：status / accounts（缓存）/ sign(dry) / credentials(set) 四条出口都不含凭据值
  const st = await c2.status()
  check(!JSON.stringify(st).includes(FAKE_CRED) && st.credentials.configured === true, 'S1 「已配置」判据仍为**文件存在 ∨ state**（D-4），且 status 不含凭据值', { cfg: st.credentials.configured, leak: JSON.stringify(st).includes(FAKE_CRED) }, { cfg: true, leak: false })
  const accOut = await A2x.accounts({ refresh: false })
  check(!JSON.stringify(accOut).includes(FAKE_CRED), 'S1 accounts 出口不含凭据值', '(含)', '(不含)')
  const signDry = await A2x.sign({ dryRun: true })
  check(!JSON.stringify(signDry).includes(FAKE_CRED), 'S1 sign(dryRun) 出口不含凭据值', '(含)', '(不含)')
  const credSet = await A2x.credentials({ action: 'set', cookie: FAKE_CRED })
  console.log('  credentials{set} => ' + JSON.stringify({ ok: credSet.ok, code: credSet.error && credSet.error.code, hasValue: JSON.stringify(credSet).includes(FAKE_CRED) }))
  check(credSet.ok === false && credSet.error && credSet.error.code === 'NOT_READY' && !JSON.stringify(credSet).includes(FAKE_CRED), 'S1 D-3 不变：写入通道未接线 ⇒ NOT_READY（strict 出口）且响应不含凭据值', { ok: credSet.ok, code: credSet.error && credSet.error.code }, { ok: false, code: 'NOT_READY' })
  const helpTxt = await A2x.help()
  check(!JSON.stringify(helpTxt).includes(FAKE_CRED), 'S1 help 出口不含凭据值', '(含)', '(不含)')
}

console.log('\n== S5 help 文案 ==')
{
  const fs = mkFs({ [DIR + '/credentials.json']: CRED_FILE })
  const { A } = mkCore(fs, { salts: JSON.parse(mkSalts('verified', SALT32)) })
  const help = await A.help()
  const out = String(help.safety.outbound)
  console.log('  safety.outbound = ' + out)
  check(out.includes('已实现'), 'S5 API 通道标注「已实现」', out.slice(0, 40), '<含 已实现>')
  check(!out.includes('只登记不实现'), 'S5 不再写「只登记不实现」', out.includes('只登记不实现'), false)
  check(out.includes('raw.githubusercontent.com') && out.includes('零凭据头'), 'S5 第三方源仍只在版本通道且明确零凭据头', '<见文案>', '<含两个要点>')
}

console.log('\n== S2+S3 sign{dryRun:false} 全链路（真 mys-http + 假 transport） ==')
{
  const fs = mkFs({ [DIR + '/credentials.json']: CRED_FILE, [DIR + '/endpoints.json']: ENDPOINT_TABLE, [DIR + '/accounts.json']: ACCOUNTS_FILE, [DIR + '/salts.json']: mkSalts('unverified-current', SALT32) })
  const clock = fakeClock(1700000000000)
  const cap = capturingTransport([{ status: 200, body: '{"retcode":0,"message":"OK","data":{"awards":[]}}' }])
  const { A: AS } = mkCore(fs, { transport: cap.t, salts: null, now: clock.now, sleep: clock.sleep, nowMs: 1700000000000 })
  const out = await AS.sign({ dryRun: false })
  console.log('  sign => ' + JSON.stringify({ ok: out.ok, dryRun: out.dryRun, verified: out.verified, saltStatus: out.saltStatus, outcome: out.results && out.results[0] && out.results[0].outcome, lastOutcome: out.lastOutcome }))
  check(out.ok === true && out.dryRun === false, 'S2 非 dryRun ⇒ 真实提交路径执行', { ok: out.ok, dry: out.dryRun }, { ok: true, dry: false })
  check(cap.calls.length === 1, 'S2 恰好 1 次出站请求', cap.calls.length, 1)
  const { url, init } = cap.calls[0]
  console.log('  request => ' + init.method + ' ' + url)
  console.log('  headers => ' + JSON.stringify(init.headers))
  check(init.method === 'POST', 'S2 method=POST', init.method, 'POST')
  check(url === 'https://api-takumi.mihoyo.com/event/luna/sign?lang=zh-cn&act_id=e202311201442471', 'S2 path/query 由端点表解析（act_id 不写死在逻辑里）', url, '<官方 URL>')
  const H = init.headers
  check(H['Cookie'] === FAKE_CRED, 'S2 头含凭据（假值，仅请求头内）', H['Cookie'], FAKE_CRED)
  check(typeof H['DS'] === 'string' && /^\d+,[A-Za-z0-9]{6},[0-9a-f]{32}$/.test(H['DS']), 'S2 头含 DS（t,r,md5 形状）', H['DS'], '<DS>')
  check(H['x-rpc-app_version'] === '2.109.0' && H['x-rpc-client_type'] === '5' && typeof H['x-rpc-device_id'] === 'string' && H['User-Agent'].includes('miHoYoBBS/2.109.0'), 'S2 头含 x-rpc-* 全家 + 固定 UA', { a: H['x-rpc-app_version'], c: H['x-rpc-client_type'], ua: H['User-Agent'].slice(-20) }, '<齐>')
  check(H['x-rpc-signgame'] === 'hk4e', 'S2 luna 路径带 signgame=目标', H['x-rpc-signgame'], 'hk4e')

  const key = dedupeKey('acct-***4321', 'hk4e', localDateOf(1700000000000))
  const state = getFile(fs, 'state.json')
  const entry = state.doneKeys[key]
  console.log('  doneKeys[' + key + '] => ' + JSON.stringify(entry))
  check(entry && entry.status === 'signed' && entry.retcode === 0 && typeof entry.at === 'string', 'S2 成功 ⇒ doneKeys[dedupeKey] = {status:signed, retcode:0, at}', entry, '<signed/0/at>')
  check(state.schedule.lastOutcome === 'signed', 'S2 lastOutcome 更新为 signed', state.schedule.lastOutcome, 'signed')
  check(state.lastSignSuccess['acct-***4321'] && state.lastSignSuccess['acct-***4321'].hk4e && state.lastSignSuccess['acct-***4321'].hk4e.saltFingerprint === saltFingerprint(SALT32), 'S2 成功写 lastSignSuccess（含盐指纹/版本 ⇒ G2③ 证据源）', state.lastSignSuccess['acct-***4321'], '<含 saltFingerprint>')

  const saltsAfter = getFile(fs, 'salts.json')
  console.log('  salts[2.109.0] => ' + JSON.stringify({ status: saltsAfter.entries['2.109.0'].status, verifiedAt: saltsAfter.entries['2.109.0'].verifiedAt, active: saltsAfter.active }))
  check(saltsAfter.entries['2.109.0'].status === 'verified' && typeof saltsAfter.entries['2.109.0'].verifiedAt === 'string', 'S3 首次成功 ⇒ 条目 unverified-current → verified 且 verifiedAt 非空', saltsAfter.entries['2.109.0'].status, 'verified')
  check(saltsAfter.active && saltsAfter.active.appVersion === '2.109.0', 'S3 active 随之非空', saltsAfter.active, '<2.109.0>')
  check(saltsAfter.entries['2.109.0'].salt === SALT32, 'S3 盐值未被改动（只升状态/时间戳）', saltsAfter.entries['2.109.0'].salt === SALT32, true)
  check(out.verified === true && out.saltStatus === 'verified', 'S3 响应如实报告已升级', { v: out.verified, s: out.saltStatus }, { v: true, s: 'verified' })
}

console.log('\n== S3b 自愈：active 为空（D-8 回退期）时真实成功 ⇒ 盐升级 + 证据落在**实际盐**上 ==')
{
  // 这一段是 t45 首次真实试签成功后**现场暴露**的缺口的回归：
  //   旧写法把 `saltInfo`（只读 active）用于 ① `lastSignSuccess.saltFingerprint` ② `upgradeSalts`。
  //   当 `active` 为空（D-8 `unverified-current` 回退期，真实试签就是这个状态）⇒ 两处都拿到 null
  //   ⇒ 签名成功了却“不自愈”：盐条目永远停在 unverified-current、active 永远补不上（G4 永久硬阻断）。
  //   注意：上面的 S3 用例 `active` 非空，因此**测不出**该缺口 —— 必须显式传 active=null。
  const fs = mkFs({ [DIR + '/credentials.json']: CRED_FILE, [DIR + '/endpoints.json']: ENDPOINT_TABLE, [DIR + '/accounts.json']: ACCOUNTS_FILE, [DIR + '/salts.json']: mkSalts('unverified-current', SALT32, null) })
  const cap = capturingTransport([{ status: 200, body: '{"retcode":0,"message":"OK","data":{"awards":[]}}' }])
  const { A: AS } = mkCore(fs, { transport: cap.t, salts: null, nowMs: 1700000000000 })
  const out = await AS.sign({ dryRun: false })
  console.log('  sign => ' + JSON.stringify({ ok: out.ok, saltStatus: out.saltStatus, saltSource: out.saltSource, verified: out.verified, outcome: out.results && out.results[0] && out.results[0].outcome }))
  check(cap.calls.length === 1 && out.results[0].outcome === 'signed', 'S3b active 为空 ⇒ 端口回退最新 unverified-current 盐完成真实签名', { calls: cap.calls.length, o: out.results[0].outcome }, { calls: 1, o: 'signed' })
  const stb = getFile(fs, 'state.json')
  const lss = stb.lastSignSuccess['acct-***4321'] && stb.lastSignSuccess['acct-***4321'].hk4e
  check(lss && lss.saltFingerprint === saltFingerprint(SALT32) && lss.appVersion === '2.109.0', 'S3b 成功证据写**实际盐**指纹/版本（旧写法 active=null ⇒ 双 null ⇒ G2③ 证据为空）', lss, { saltFingerprint: saltFingerprint(SALT32), appVersion: '2.109.0' })
  const sa = getFile(fs, 'salts.json')
  console.log('  salts[2.109.0] => ' + JSON.stringify({ status: sa.entries['2.109.0'].status, verifiedAt: sa.entries['2.109.0'].verifiedAt, active: sa.active }))
  check(sa.entries['2.109.0'].status === 'verified' && typeof sa.entries['2.109.0'].verifiedAt === 'string', 'S3b active=null 时成功**同样自愈**：unverified-current → verified', sa.entries['2.109.0'].status, 'verified')
  check(sa.active && sa.active.appVersion === '2.109.0', 'S3b 升级后 active 被补上（G4 硬阻断得以解除的前提）', sa.active, '<2.109.0>')
  check(sa.entries['2.109.0'].salt === SALT32, 'S3b 盐值未被改动（只升状态/时间戳）', sa.entries['2.109.0'].salt === SALT32, true)
  check(out.verified === true && out.saltStatus === 'verified', 'S3b 回执如实报告自愈结果', { v: out.verified, s: out.saltStatus }, { v: true, s: 'verified' })
}

console.log('\n== S2 其余三条 outcome（already / human_required / failed）==')
{
  // already：服务端说已签到 ⇒ status:already；**t52/G2a 起也写** lastSignSuccess（带 effectiveSalt 指纹）；**不**升级盐
  //
  // ── E13：**断言改写留痕（改前 → 改后 + 理由）** ─────────────────────────────────────────────
  //   改前（t31 起，共 3 个版本）：`check(Object.keys(state.lastSignSuccess).length === 0, 'S2 already **不写** lastSignSuccess（设计 §5.2：只真实成功才写）', …)`
  //   改后（t52，本块）：`already` **也写** lastSignSuccess，且 `outcome` 保持 `'already'`、`doneKeys.status` 保持 `'already'`。
  //   理由（captain 裁决 A）：`-5003`「已签到」证明**服务端已用当前这把盐受理**了请求并告知状态 ⇒
  //     它足以充当 G2 的「同源成功记录」；否则"今天已签"的用户**永远**过不了 G2（当日不可能再拿到 `signed`）。
  //   t46/J1 早已把 `already` 当作 G1 的"认证成功"，此处只是把 G2 的口径与之对齐（同一把尺子）。
  //   护栏：① `outcome` 绝不写 `'success'`；② `doneKeys.status` 绝不改成 `'signed'`；③ 不新增任何"今日新签"计数。
  // ─────────────────────────────────────────────────────────────────────────────────────────
  const fs = mkFs({ [DIR + '/credentials.json']: CRED_FILE, [DIR + '/endpoints.json']: ENDPOINT_TABLE, [DIR + '/accounts.json']: ACCOUNTS_FILE, [DIR + '/salts.json']: mkSalts('unverified-current', SALT32) })
  const cap = capturingTransport([{ status: 200, body: '{"retcode":-5003,"message":"今天已经签到过啦"}' }])
  const { A } = mkCore(fs, { transport: cap.t, salts: null, nowMs: 1700000000000 })
  const out = await A.sign({ dryRun: false })
  const key = dedupeKey('acct-***4321', 'hk4e', localDateOf(1700000000000))
  const state = getFile(fs, 'state.json')
  console.log('  already => ' + JSON.stringify({ outcome: out.results[0].outcome, retcode: out.results[0].retcode, done: state.doneKeys[key].status, lss: state.lastSignSuccess['acct-***4321'] && state.lastSignSuccess['acct-***4321'].hk4e }))
  check(out.results[0].outcome === 'already' && state.doneKeys[key].status === 'already', 'S2 已签到族 ⇒ outcome/status = already', out.results[0].outcome, 'already')
  const lssAlready = state.lastSignSuccess['acct-***4321'] && state.lastSignSuccess['acct-***4321'].hk4e
  check(!!lssAlready && lssAlready.outcome === 'already' && lssAlready.retcode === -5003, 'S2/G2a already **写** lastSignSuccess（**护栏①**：outcome 保持 already，绝不写 success）', lssAlready, '<outcome:already/retcode:-5003>')
  check(lssAlready && lssAlready.saltFingerprint === saltFingerprint(SALT32) && lssAlready.appVersion === '2.109.0', 'S2/G2a already 记录带 **effectiveSalt 指纹 + appVersion**（G2③ 才有判据可用）', lssAlready && { fp: lssAlready.saltFingerprint, v: lssAlready.appVersion }, { fp: saltFingerprint(SALT32), v: '2.109.0' })
  check(state.doneKeys[key].status !== 'signed', 'S2/G2a **护栏②负对照**：already ⇒ `doneKeys.status !== \'signed\'`（不得把"已签"改写成"本次签成"）', state.doneKeys[key].status, '<≠signed>')
  check(getFile(fs, 'salts.json').entries['2.109.0'].status === 'unverified-current', 'S2 already **不**触发盐升级（未取得同源成功证据）', getFile(fs, 'salts.json').entries['2.109.0'].status, 'unverified-current')

  // human_required：验证码族 ⇒ 终态 + pausedBy=GEETEST_REQUIRED
  const fs2 = mkFs({ [DIR + '/credentials.json']: CRED_FILE, [DIR + '/endpoints.json']: ENDPOINT_TABLE, [DIR + '/accounts.json']: ACCOUNTS_FILE, [DIR + '/salts.json']: mkSalts('verified', SALT32) })
  const cap2 = capturingTransport([{ status: 200, body: '{"retcode":-3004,"message":"请完成验证码后重试"}' }])
  const { A: A2 } = mkCore(fs2, { transport: cap2.t, salts: null, nowMs: 1700000000000 })
  const out2 = await A2.sign({ dryRun: false })
  const st2 = getFile(fs2, 'state.json')
  console.log('  human_required => ' + JSON.stringify({ outcome: out2.results[0].outcome, pausedBy: st2.schedule.pausedBy, classify: out2.results[0].classify }))
  check(out2.results[0].outcome === 'human_required' && st2.schedule.pausedBy === 'GEETEST_REQUIRED', 'S2 验证码族 ⇒ human_required 且 pausedBy=GEETEST_REQUIRED（§8.1）', out2.results[0].outcome, 'human_required')

  // force 语义：仅当该组合当日已 human_required 时才允许一次
  const cap3 = capturingTransport([{ status: 200, body: '{"retcode":0,"message":"OK"}' }])
  const { A: A3 } = mkCore(fs2, { transport: cap3.t, salts: null, nowMs: 1700000000000 })
  const forced = await A3.sign({ dryRun: false, force: true })
  console.log('  force(human_required 后) => ' + JSON.stringify({ ok: forced.ok, outcome: forced.results && forced.results[0] && forced.results[0].outcome }))
  check(forced.ok === true && forced.results[0].outcome === 'signed', 'S2 force:true 在 human_required 之后允许一次真实提交（§8.1）', forced.results[0].outcome, 'signed')
  const fsNo = mkFs({ [DIR + '/credentials.json']: CRED_FILE, [DIR + '/endpoints.json']: ENDPOINT_TABLE, [DIR + '/accounts.json']: ACCOUNTS_FILE, [DIR + '/salts.json']: mkSalts('verified', SALT32) })
  const { A: A4 } = mkCore(fsNo, { transport: capturingTransport([{ status: 200, body: '{"retcode":0}' }]).t, salts: null, nowMs: 1700000000000 })
  const badForce = await A4.sign({ dryRun: false, force: true })
  check(badForce.ok === false && badForce.error && badForce.error.code === 'BAD_ARG', 'S2 force:true 无 human_required 前置 ⇒ BAD_ARG（语义不变）', badForce.error && badForce.error.code, 'BAD_ARG')

  // failed：5xx ⇒ failed；AUTH_INVALID ⇒ failed + pausedBy=AUTH_INVALID
  const fs3 = mkFs({ [DIR + '/credentials.json']: CRED_FILE, [DIR + '/endpoints.json']: ENDPOINT_TABLE, [DIR + '/accounts.json']: ACCOUNTS_FILE, [DIR + '/salts.json']: mkSalts('verified', SALT32) })
  const { A: A5 } = mkCore(fs3, { transport: capturingTransport([{ status: 500, body: 'boom' }, { status: 500, body: 'boom' }, { status: 500, body: 'boom' }]).t, salts: null, nowMs: 1700000000000 })
  const out5 = await A5.sign({ dryRun: false })
  check(out5.results[0].outcome === 'failed' && out5.results[0].httpStatus === 500, 'S2 5xx ⇒ failed（重试穷尽后）', out5.results[0].outcome, 'failed')
  const fs4 = mkFs({ [DIR + '/credentials.json']: CRED_FILE, [DIR + '/endpoints.json']: ENDPOINT_TABLE, [DIR + '/accounts.json']: ACCOUNTS_FILE, [DIR + '/salts.json']: mkSalts('verified', SALT32) })
  const { A: A6 } = mkCore(fs4, { transport: capturingTransport([{ status: 200, body: '{"retcode":-100,"message":"登录状态失效"}' }]).t, salts: null, nowMs: 1700000000000 })
  const out6 = await A6.sign({ dryRun: false })
  const st6 = getFile(fs4, 'state.json')
  console.log('  AUTH_INVALID => ' + JSON.stringify({ outcome: out6.results[0].outcome, classify: out6.results[0].classify, pausedBy: st6.schedule.pausedBy }))
  check(out6.results[0].outcome === 'failed' && out6.results[0].classify === 'AUTH_INVALID' && st6.schedule.pausedBy === 'AUTH_INVALID', 'S2 retcode=-100 ⇒ failed + classify/pausedBy=AUTH_INVALID（§6.1/§10.3）', st6.schedule.pausedBy, 'AUTH_INVALID')
}

console.log('\n== S2 端点缺项 ⇒ ENDPOINT_DRIFT 且**零请求**；当日去重 ==')
{
  const fs = mkFs({ [DIR + '/credentials.json']: CRED_FILE, [DIR + '/accounts.json']: ACCOUNTS_FILE, [DIR + '/salts.json']: mkSalts('verified', SALT32) })
  const cap = capturingTransport([{ status: 200, body: '{"retcode":0}' }])
  const { A: AD } = mkCore(fs, { transport: cap.t, salts: null, nowMs: 1700000000000 })
  const out = await AD.sign({ dryRun: false })
  console.log('  endpoints 缺失 => ' + JSON.stringify({ ok: out.ok, code: out.error && out.error.code, calls: cap.calls.length }))
  check(out.ok === false && out.error && out.error.code === 'ENDPOINT_DRIFT' && cap.calls.length === 0, 'S2 端点表缺项 ⇒ ENDPOINT_DRIFT 且不发请求（§2.1）', { code: out.error && out.error.code, calls: cap.calls.length }, { code: 'ENDPOINT_DRIFT', calls: 0 })
  check(String(out.error.message).includes('endpoints.json'), 'S2 报错给出应填写的文件路径', out.error.message.slice(0, 40), '<含 endpoints.json>')

  // 当日去重：首次 signed 后再调用（即使 force）⇒ 不再提交
  const fs2 = mkFs({ [DIR + '/credentials.json']: CRED_FILE, [DIR + '/endpoints.json']: ENDPOINT_TABLE, [DIR + '/accounts.json']: ACCOUNTS_FILE, [DIR + '/salts.json']: mkSalts('verified', SALT32) })
  const cap2 = capturingTransport([{ status: 200, body: '{"retcode":0}' }, { status: 200, body: '{"retcode":0}' }])
  const { A: AR } = mkCore(fs2, { transport: cap2.t, salts: null, nowMs: 1700000000000 })
  const first = await AR.sign({ dryRun: false })
  const second = await AR.sign({ dryRun: false })
  console.log('  第一次 results=' + JSON.stringify(first.results) + ' selected=' + first.selected)
  console.log('  同账号两次调用 => calls=' + cap2.calls.length + ' 第二次=' + JSON.stringify(second.results[0] && second.results[0].outcome) + ' urls=' + JSON.stringify(cap2.calls.map((c) => c.url)))
  check(cap2.calls.length === 1 && second.results[0].outcome === 'skipped_done', 'S2 当日去重生效：已 signed ⇒ 第二次 skipped_done 且不再提交（§5.2）', { calls: cap2.calls.length, o: second.results[0].outcome }, { calls: 1, o: 'skipped_done' })
}

console.log('\n== S4 accounts{refresh:true} 角色映射 ==')
{
  const rolesBody = JSON.stringify({
    retcode: 0, message: 'OK',
    data: {
      list: [
        { game_biz: 'hk4e_cn', region: 'cn_gf01', game_uid: '123456789', nickname: '旅行者', level: 60 },
        { game_biz: 'nap_cn', region: 'prod_gf_cn', game_uid: '987654321', nickname: '绳匠', level: 42 },
        { game_biz: 'unknown_biz', region: 'x', game_uid: '1', nickname: 'n', level: 1 },
      ],
    },
  })
  const fs = mkFs({ [DIR + '/credentials.json']: CRED_FILE, [DIR + '/salts.json']: mkSalts('verified', SALT32), [DIR + '/accounts.json']: ACCOUNTS_FILE })
  const cap = capturingTransport([{ status: 200, body: rolesBody }])
  const { A } = mkCore(fs, { transport: cap.t, salts: null, nowMs: 1700000000000 })
  const out = await A.accounts({ refresh: true })
  console.log('  accounts => ' + JSON.stringify(out).slice(0, 420))
  check(out.ok === true && out.source === 'refresh' && out.persisted === true, 'S4 refresh 走真实查询且**落盘**（persisted:true；t38 起写入通道已接线）', { src: out.source, p: out.persisted }, { src: 'refresh', p: true })
  check(Array.isArray(out.accounts) && out.accounts.length === 1 && out.accounts[0].accountKey === 'acct-***4321', 'S4 accountKey 取自凭据文件身份字段（脱敏键）', out.accounts && out.accounts[0] && out.accounts[0].accountKey, 'acct-***4321')
  const roles = out.accounts[0].roles
  check(roles.length === 2, 'S4 未知 game_biz 被跳过（只留可归属角色）', roles.length, 2)
  check(roles[0].gameKey === 'hk4e' && roles[0].gameUidTail === '***6789' && roles[0].nickname === '旅行者' && roles[0].level === 60, 'S4 角色映射（game_biz→hk4e + uid 只出尾号 + nickname/level）', roles[0], '<hk4e/***6789>')
  check(roles[1].gameKey === 'zzz' && roles[1].gameUidTail === '***4321', 'S4 nap_cn → zzz（§2.2 host 例外同源）', roles[1].gameKey, 'zzz')
  check(!JSON.stringify(out).includes('123456789') && !JSON.stringify(out).includes(FAKE_CRED), 'S4 出口不含 uid 原值 / 不含凭据值', '(含)', '(不含)')
  check(fs.calls.filter((c) => c.op === 'writeJson' && c.rel === 'miyoushe/accounts.json').length === 1, 'S4 **落盘 1 次** accounts.json（t38 起写入通道已接线）', fs.calls.filter((c) => c.op === 'writeJson' && c.rel === 'miyoushe/accounts.json').length, 1)
  const outCache = await A.accounts({})
  check(outCache.source === 'cache' && outCache.count === 1, 'S4 非 refresh ⇒ 仍走缓存路径（行为不变）', { s: outCache.source, c: outCache.count }, { s: 'cache', c: 1 })
}

console.log('\n== t41/A1–A5 accounts.json 落盘通道（写入 → 读回 → 组合数；t38 行为等价复核）==')
{
  // 真实形状夹具：官方 `getUserGameRolesByCookie` 响应（含 uid/game_uid/region/nickname/level）
  const rolesBody = JSON.stringify({
    retcode: 0, message: 'OK',
    data: {
      list: [
        { game_biz: 'hk4e_cn', region: 'cn_gf01', game_uid: '123456789', nickname: '旅行者', level: 60, uid: '10004321' },
        { game_biz: 'hkrpg_cn', region: 'prod_gf_cn', game_uid: '111222333', nickname: '星穹', level: 70 },
        { game_biz: 'nap_cn', region: 'prod_gf_cn', game_uid: '987654321', nickname: '绳匠', level: 42 },
        { game_biz: 'bh3_cn', region: 'android01', game_uid: '555666777', nickname: '舰长', level: 83 },
        { game_biz: 'unknown_biz', region: 'x', game_uid: '1', nickname: 'n', level: 1 },
      ],
    },
  })
  const fs = mkFs({ [DIR + '/credentials.json']: CRED_FILE, [DIR + '/salts.json']: mkSalts('verified', SALT32) }) // 故意**不放** accounts.json
  const cap = capturingTransport([{ status: 200, body: rolesBody }])
  const { core, A } = mkCore(fs, { transport: cap.t, salts: null, nowMs: 1700000000000 })

  // A2：文件缺失 ⇒ 空骨架、不抛
  let skeleton = null
  let threw = false
  try { skeleton = await readAccountsFile(fs) } catch (e) { threw = true }
  check(threw === false && skeleton && skeleton.version === 1 && skeleton.updatedAt === null && Array.isArray(skeleton.accounts) && skeleton.accounts.length === 0, 'A2 文件缺失 ⇒ readAccountsFile 返回空骨架且不抛错', skeleton, '<{version:1,updatedAt:null,accounts:[]}>')
  const accMissing = await A.accounts({})
  check(accMissing.ok === true && accMissing.source === 'cache' && accMissing.count === 0, 'A2/A5 缺文件时 accounts 走缓存 ⇒ count:0', { s: accMissing.source, c: accMissing.count }, { s: 'cache', c: 0 })

  const out = await A.accounts({ refresh: true })
  console.log('  accounts{refresh:true} => ' + JSON.stringify(out))
  check(out.ok === true && out.persisted === true && out.path === 'miyoushe/accounts.json', 'A1 refresh 成功 ⇒ persisted:true 且回执给出本机路径', { p: out.persisted, path: out.path }, { p: true, path: 'miyoushe/accounts.json' })
  check(cap.calls.length === 1, 'A1 发现请求恰好 1 次（落盘不额外发请求）', cap.calls.length, 1)
  check(out.count === 4 && out.persistedCount === 1, 'F4① count = 4 个角色（未知 biz 跳过）', { n: out.count, pc: out.persistedCount }, { n: 4, pc: 1 })

  // A2：磁盘形状逐项断言（含**原值** uid/region —— 本机数据面不脱敏）
  const disk = JSON.parse(fs.files.get(DIR + '/accounts.json'))
  console.log('  disk => ' + JSON.stringify(disk))
  check(disk.version === 1 && typeof disk.updatedAt === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(disk.updatedAt), 'A2 落盘 shape：{version:1, updatedAt:<ISO>, accounts:[…]}', { v: disk.version, u: typeof disk.updatedAt }, { v: 1, u: 'string' })
  check(disk.accounts.length === 1 && disk.accounts[0].accountKey === 'acct-***4321' && disk.accounts[0].uid === '10004321', 'A2/A1 落盘保留**原值** uid（数据面不脱敏）', { k: disk.accounts[0] && disk.accounts[0].accountKey, u: disk.accounts[0] && disk.accounts[0].uid }, { k: 'acct-***4321', u: '10004321' })
  // F4①：gameUid **非空**（t38 的真缺陷正是只留尾号 ⇒ 这里逐项断言原值）
  const allGameUids = disk.accounts[0].roles.map((r) => r.gameUid)
  check(disk.accounts[0].roles.length === 4 && allGameUids.every((u) => typeof u === 'string' && u.length > 0), 'F4① 落盘 4 个角色的 `gameUid` **全部非空**（原值，签名需要）', allGameUids, '<4 个非空串>')
  check(allGameUids.join(',') === '123456789,111222333,987654321,555666777', 'F4① gameUid 原值逐条正确（与夹具同源）', allGameUids.join(','), '123456789,111222333,987654321,555666777')
  check(disk.accounts[0].roles[0].region === 'cn_gf01' && disk.accounts[0].roles[0].nickname === '旅行者' && disk.accounts[0].roles[0].level === 60, 'A2 落盘角色项 {gameKey,region,gameUid,nickname,level} 逐项原值', disk.accounts[0].roles[0], '<hk4e/cn_gf01/123456789/旅行者/60>')
  check(disk.accounts[0].roles.map((r) => r.gameKey).join(',') === 'hk4e,hkrpg,zzz,bh3', 'A2 四个已知 biz 全进（未知 game_biz 仍跳过）', disk.accounts[0].roles.map((r) => r.gameKey).join(','), 'hk4e,hkrpg,zzz,bh3')

  // A4①：落盘 → 读回**逐字一致**（双路径：本文件读 + store 读）
  const back = await readAccountsFile(fs)
  check(JSON.stringify(back) === JSON.stringify(disk), 'A4 读回与落盘**逐字一致**（round-trip）', JSON.stringify(back).slice(0, 60), JSON.stringify(disk).slice(0, 60))
  const backViaStore = await core.store.readAccounts()
  check(JSON.stringify(backViaStore) === JSON.stringify(disk), 'A4 经 store.readAccounts()（调度/门禁/试签的真实读路径）读回亦逐字一致', JSON.stringify(backViaStore).slice(0, 60), JSON.stringify(disk).slice(0, 60))

  // A4②：出口无完整 uid / 无凭据值（逐字扫描）
  const exitText = JSON.stringify(out)
  const leaks = ['123456789', '111222333', '987654321', '555666777', '10004321', FAKE_CRED].filter((s) => exitText.includes(s))
  check(leaks.length === 0, 'F4② 出口**无完整 uid、无凭据值**（逐字扫描 5 个 uid 与凭据假值）', leaks, [])
  check(out.accounts[0].roles[0].gameUidTail === '***6789' && out.accounts[0].uidTail === '***4321', 'A4 出口只给尾号（uidTail / gameUidTail）', { u: out.accounts[0].uidTail, g: out.accounts[0].roles[0].gameUidTail }, { u: '***4321', g: '***6789' })
  const mappedRoles = mapDiscoveredRoles({ ok: true, data: { list: JSON.parse(rolesBody).data.list } }).roles
  check(mappedRoles[0].gameUid === '123456789' && mappedRoles[0].gameUidTail === '***6789', 'A4 mapDiscoveredRoles 同时给出**原值**（只供落盘）与**尾号**（供出口）', { raw: mappedRoles[0].gameUid, tail: mappedRoles[0].gameUidTail }, { raw: '123456789', tail: '***6789' })

  // A7：凭据值绝不进 accounts.json（逐字扫描磁盘原文）
  const diskText = fs.files.get(DIR + '/accounts.json')
  check(!diskText.includes(FAKE_CRED) && !/credential|cookie|token/i.test(diskText.replace(/"nickname":"[^"]*"/g, '')), 'A7 accounts.json 内**无凭据位/无凭据值**（逐字扫描磁盘原文）', '<见注>', '<无>')
  check(fs.calls.filter((c) => c.op === 'writeJson' && c.rel === 'miyoushe/accounts.json').length === 1, 'A1 只写 1 次（无重复写盘）', fs.calls.filter((c) => c.op === 'writeJson' && c.rel === 'miyoushe/accounts.json').length, 1)
}

console.log('\n== t38/A1 边界：roles 为空 ⇒ 绝不把已存在清单覆盖成空 ==')
{
  const fs = mkFs({ [DIR + '/credentials.json']: CRED_FILE, [DIR + '/salts.json']: mkSalts('verified', SALT32) })
  const cap = capturingTransport([{ status: 200, body: '{"retcode":0,"message":"OK","data":{"list":[]}}' }])
  const { A } = mkCore(fs, { transport: cap.t, salts: null, nowMs: 1700000000000 })
  const out = await A.accounts({ refresh: true })
  const disk = JSON.parse(fs.files.get(DIR + '/accounts.json'))
  console.log('  empty-list refresh => ' + JSON.stringify({ ok: out.ok, count: out.count, reason: out.reason, persisted: out.persisted, diskAccounts: disk.accounts.length }))
  check(out.ok === true && out.reason === 'EMPTY_LIST' && out.persisted === true && disk.accounts.length === 1 && disk.accounts[0].roles.length === 0, 'A1 空列表 ⇒ 仍写账号骨架（roles:[]）、**不**清空关键位、不谎报成功', { n: disk.accounts.length, r: disk.accounts[0] && disk.accounts[0].roles.length }, { n: 1, r: 0 })
  check(disk.accounts[0].uid === '10004321', 'A1 空列表时 uid 仍取凭据身份原值（数据面原值）', disk.accounts[0].uid, '10004321')
}

console.log('\n== t41/F1 config 写入侧：形状校验 + fail-closed 拒绝 + 缺省补齐 ==')
{
  const fsCfg = mkFs({ [DIR + '/credentials.json']: CRED_FILE, [DIR + '/salts.json']: mkSalts('verified', SALT32) })
  const { A } = mkCore(fsCfg, { salts: null, nowMs: 1700000000000 })
  const readSched = () => JSON.parse(fsCfg.files.get(DIR + '/settings.json')).schedule
  const okCfg = await A.config({ patch: { schedule: { spreadMinGapMs: 600000, spreadJitterMs: [30000, 120000], targets: ['hk4e:cn_gf01', 'hkrpg:prod_gf_cn', 'zzz:prod_gf_cn', 'bh3:bb01'] } } })
  check(okCfg.ok === true, 'F1 合法 schedule 补丁 ⇒ 写入成功', okCfg.ok, true)
  const w1 = readSched()
  check(w1.spreadMinGapMs === 600000 && JSON.stringify(w1.spreadJitterMs) === '[30000,120000]' && w1.targets.length === 4, 'F1 落盘含三项（值逐字一致）', w1, '<三项>')
  const bad = [
    [{ spreadMinGapMs: -1 }, '负值'],
    [{ spreadMinGapMs: 1.5 }, '小数'],
    [{ spreadJitterMs: [120000, 30000] }, '区间颠倒（**必须拒绝，不得夹取**）'],
    [{ spreadJitterMs: [30000] }, '区间长度≠2'],
    [{ spreadJitterMs: 30000 }, '区间非数组'],
    [{ targets: ['HK4E:CN'] }, 'targets 大写'],
    [{ targets: [''] }, 'targets 空元素'],
    [{ targets: 'hk4e' }, 'targets 非数组'],
    [{ unknownKey: 1 }, '未知子键'],
    [{ enabled: 'yes' }, 'enabled 非布尔'],
  ]
  let allBad = true
  const codes = []
  for (const [p, label] of bad) {
    const r = await A.config({ patch: { schedule: p } })
    const code = r.ok === false && r.error ? r.error.code : 'OK?'
    codes.push(label + '=' + code)
    if (code !== 'BAD_ARG') allBad = false
  }
  console.log('  F1 十类非法补丁 => ' + JSON.stringify(codes))
  check(allBad, 'F1 **fail-closed**：十类非法/畸形值一律 `BAD_ARG` 拒绝（含区间颠倒**不夹取**）', codes, '<10×BAD_ARG>')
  const w2 = readSched()
  check(w2.spreadMinGapMs === 600000 && JSON.stringify(w2.spreadJitterMs) === '[30000,120000]', 'F1 非法补丁**不写盘**（原值逐字保留，无静默回落）', w2, '<原值>')
  // 缺省补齐：只给一个键 ⇒ 其余补缺省
  const okDef = await A.config({ patch: { schedule: { spreadMinGapMs: 300000 } } })
  const w3 = readSched()
  check(okDef.ok === true && w3.spreadMinGapMs === 300000 && JSON.stringify(w3.spreadJitterMs) === '[30000,120000]' && Array.isArray(w3.targets), 'F1 缺省补齐（只给 minGap ⇒ jitter/targets 取缺省）', { g: w3.spreadMinGapMs, j: w3.spreadJitterMs, t: w3.targets.length }, { g: 300000, j: [30000, 120000], t: 4 })
  const okOff = await A.config({ patch: { schedule: { spreadMinGapMs: 0, spreadJitterMs: [0, 0] } } })
  const w4 = readSched()
  check(okOff.ok === true && w4.spreadMinGapMs === 0 && JSON.stringify(w4.spreadJitterMs) === '[0,0]', 'F1 显式关掉分散（0/[0,0]）⇒ 被尊重（不被缺省改回）', { g: w4.spreadMinGapMs, j: w4.spreadJitterMs }, { g: 0, j: [0, 0] })
  const okTgt = await A.config({ patch: { schedule: { targets: [] } } })
  check(okTgt.ok === true && readSched().targets.length === 0, 'F1 targets 置空 ⇒ 全部组合（其余项保留）', readSched().targets.length, 0)
}

console.log('\n== t41/F2 schedule 出口暴露 spread / dailyPlan（不含 uid） ==')
{
  const fsSched = mkFs({
    [DIR + '/credentials.json']: CRED_FILE,
    [DIR + '/salts.json']: mkSalts('verified', SALT32),
    [DIR + '/accounts.json']: JSON.stringify({
      version: 1, updatedAt: null,
      accounts: [{ accountKey: 'acct-***4321', uid: '10004321', roles: [
        { gameKey: 'hk4e', region: 'cn_gf01', gameUid: '123456789' },
        { gameKey: 'bh3', region: 'bb01', gameUid: '555666777' },
        { gameKey: 'bh3', region: 'pc01', gameUid: '111000111' },
      ] }],
    }),
    [DIR + '/settings.json']: JSON.stringify(Object.assign({}, JSON.parse(SETTINGS_FILE), {
      schedule: { enabled: true, spreadMinGapMs: 600000, spreadJitterMs: [30000, 120000], targets: ['hk3e:cn_gf01', 'hk4e:cn_gf01'] },
    })),
  })
  // 上面 targets 故意写一个不存在的 gameKey（hk3e）以证明"精确匹配"不会误命中
  const A = mkCore(fsSched, { salts: null, nowMs: 1700000000000 }).A
  const s = await A.schedule()
  console.log('  schedule.spread => ' + JSON.stringify(s.spread))
  console.log('  schedule.dailyPlan = ' + JSON.stringify(s.dailyPlan && { date: s.dailyPlan.date, items: s.dailyPlan.items.map((x) => x.comboKey + '@' + x.at), degraded: s.dailyPlan.spreadDegraded, reason: s.dailyPlan.spreadDegradedReason }))
  check(s.ok === true && s.spread && s.spread.minGapMs === 600000 && JSON.stringify(s.spread.jitterMs) === '[30000,120000]', 'F2 `spread` 暴露 minGapMs / jitterMs', s.spread, '<minGapMs/jitterMs>')
  check(Array.isArray(s.spread.targets) && s.spread.targets.length === 2, 'F2 `spread.targets` 原样暴露（含用户写错的项也不改写）', s.spread.targets, '<2 项>')
  check(s.spread.enabled === true && s.spread.degraded === false && s.spread.degradedReason === null, 'F2 `spread.enabled/degraded/degradedReason` 可见', { e: s.spread.enabled, d: s.spread.degraded, r: s.spread.degradedReason }, { e: true, d: false, r: null })
  check(s.dailyPlan && typeof s.dailyPlan.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s.dailyPlan.date), 'F2 `dailyPlan.date` 可见（yyyy-mm-dd）', s.dailyPlan && s.dailyPlan.date, '<yyyy-mm-dd>')
  check(Array.isArray(s.dailyPlan.items) && s.dailyPlan.items.length === 1 && s.dailyPlan.items[0].comboKey === 'hk4e:cn_gf01' && Number.isFinite(s.dailyPlan.items[0].at), 'F2 `dailyPlan.items[{comboKey, at}]`（精确匹配：hk3e 不误命中，bh3 两个区服被 4 段精确过滤掉）', s.dailyPlan.items.map((x) => x.comboKey), ['hk4e:cn_gf01'])
  const schedText = JSON.stringify(s.dailyPlan)
  const uidLeaks = ['10004321', '123456789', '555666777', '111000111', FAKE_CRED].filter((x) => schedText.includes(x))
  check(uidLeaks.length === 0, 'F2 dailyPlan **不含 uid / 不含凭据**（逐字扫描）', uidLeaks, [])
  check(!/\b(10004321|123456789)\b/.test(JSON.stringify(s)), 'F2 整个 schedule 出口无完整 uid', 'ok', 'true')
  // 降级路径也要可见
  const fsDeg = mkFs({
    [DIR + '/credentials.json']: CRED_FILE,
    [DIR + '/salts.json']: mkSalts('verified', SALT32),
    [DIR + '/accounts.json']: fsSched.files.get(DIR + '/accounts.json'),
    [DIR + '/settings.json']: JSON.stringify(Object.assign({}, JSON.parse(SETTINGS_FILE), {
      windowStart: '08:00', windowEnd: '08:20',
      schedule: { enabled: true, spreadMinGapMs: 600000, spreadJitterMs: [30000, 120000], targets: [] },
    })),
  })
  const sDeg2 = await createActions(createCore({ adapterFs: fsDeg, now: () => 1700000000000 })).schedule()
  console.log('  F2 降级 => ' + JSON.stringify({ degraded: sDeg2.spread && sDeg2.spread.degraded, reason: sDeg2.spread && sDeg2.spread.degradedReason, n: sDeg2.dailyPlan && sDeg2.dailyPlan.items.length }))
  check(sDeg2.spread && sDeg2.spread.degraded === true && typeof sDeg2.spread.degradedReason === 'string', 'F2 `spreadDegraded` 与原因**可见**（窗口过短 ⇒ 降级）', { d: sDeg2.spread && sDeg2.spread.degraded, r: sDeg2.spread && sDeg2.spread.degradedReason }, '<true + 原因串>')
}

console.log('\n== t41/F3 业务键：region 感知 4 段（同账号 bh3 三区服 ⇒ 3 个互不相同的键） ==')
{
  const today = localDateOf(1700000000000)
  const threeRegions = ['bb01', 'pc01', 'android01']
  const keys = threeRegions.map((r) => dedupeKey('acct-***4321', 'bh3', today, r))
  check(new Set(keys).size === 3, 'F3 同账号 bh3 三区服 ⇒ 3 个**互不相同**的去重键', keys, '<3 个不同值>')
  check(keys[0] === 'acct-***4321:bh3:' + today + ':bb01' && keys[2] === 'acct-***4321:bh3:' + today + ':android01', 'F3 4 段形状 `${acct}:${target}:${date}:${region}`', keys, '<4 段>')
  check(dedupeKey('acct-***4321', 'bbs', today, '') === 'acct-***4321:bbs:' + today, 'F3 bbs（无区服）仍 3 段（逐字不变）', dedupeKey('acct-***4321', 'bbs', today, ''), '<3 段>')
  // `A.sign` 出口的键与 dedupeKey 一致（3 个区服各一条）
  const bh3Accounts = JSON.stringify({
    version: 1, updatedAt: null,
    accounts: [{ accountKey: 'acct-***4321', uid: '10004321', roles: threeRegions.map((r, i) => ({ gameKey: 'bh3', region: r, gameUid: '55' + i })) }],
  })
  const fsBh3 = mkFs({
    [DIR + '/credentials.json']: CRED_FILE,
    [DIR + '/salts.json']: mkSalts('verified', SALT32),
    [DIR + '/accounts.json']: bh3Accounts,
    [DIR + '/settings.json']: JSON.stringify(Object.assign({}, JSON.parse(SETTINGS_FILE), { bbsEnabled: false, schedule: { enabled: false, targets: [] } })),
  })
  const { A } = mkCore(fsBh3, { salts: null, nowMs: 1700000000000 })
  const signOut = await A.sign({ dryRun: true })
  const signKeys = (signOut.results || []).map((r) => r.dedupeKey)
  console.log('  F3 A.sign{dryRun:true} => ' + JSON.stringify(signOut.results))
  check(signOut.ok === true && signOut.selected === 3, 'F3 A.sign 选中 3 个 bh3 区服组合（不再是 1 个）', signOut.selected, 3)
  check(signKeys.length === 3 && new Set(signKeys).size === 3, 'F3 A.sign 出口使用 3 个互不相同的 region 键', signKeys, '<3 个不同值>')
  check(signKeys.every((k) => k.indexOf(':bh3:' + today + ':') > 0), 'F3 A.sign 键带 region（4 段）', signKeys, '<全为 4 段>')
  check(signKeys.join(',') === threeRegions.map((r) => dedupeKey('acct-***4321', 'bh3', today, r)).join(','), 'F3 A.sign 键与 dedupeKey(region) **逐字一致**', signKeys.join(','), '<同 dedupeKey>')
  const runOut = await A.run({})
  const runKeys = (runOut.results || []).map((r) => r.dedupeKey)
  check(runOut.ok === true && runKeys.length === 3 && new Set(runKeys).size === 3 && runKeys.every((k) => k.indexOf(':bh3:' + today + ':') > 0), 'F3 A.run 同样使用 3 个 region 键', runKeys, '<3 个不同值 + 4 段>')
  check(JSON.stringify(runKeys) === JSON.stringify(signKeys), 'F3 A.run 与 A.sign 的键集合逐字一致', runKeys, signKeys)
  // **两份实现必须同口径**（index.js 因"入口不得 import 非入口新增导出"自带一份；此处交叉断言防止漂移）
  const crossOk = ['bb01', 'pc01', 'android01', ''].every((r) => bizKey('acct-***4321', 'bh3', today, r) === dedupeKey('acct-***4321', 'bh3', today, r)) &&
    bizKey('acct-***4321', 'bbs', today, '') === dedupeKey('acct-***4321', 'bbs', today, '')
  check(crossOk, 'F3 index.js 的 `bizKey` 与 scheduler.js 的 `dedupeKey` **逐字同口径**（两份实现在 5 组输入上一致）', crossOk, true)
  check(SPREAD_DEFAULTS.spreadMinGapMs === 600000 && JSON.stringify(SPREAD_DEFAULTS.spreadJitterMs) === '[30000,120000]' && SPREAD_DEFAULTS.targets.length === 0, 'F1 index.js 的 `SPREAD_DEFAULTS` 与 scheduler.js 同值（600000 / [30000,120000] / []）', SPREAD_DEFAULTS, '<三项>')
  // 旧 3 段键仍可被读到（兼容读）
  const fsLegacy = mkFs({
    [DIR + '/credentials.json']: CRED_FILE,
    [DIR + '/salts.json']: mkSalts('verified', SALT32),
    [DIR + '/accounts.json']: bh3Accounts,
    [DIR + '/state.json']: jsonStateWithDoneKey('acct-***4321:bh3:' + today, { status: 'human_required', attempts: 1 }),
  })
  const AL = mkCore(fsLegacy, { salts: null, nowMs: 1700000000000 }).A
  const legacyOut = await AL.sign({ accountKey: 'acct-***4321', gameKey: 'bh3', force: true, dryRun: true })
  check(legacyOut.ok === true && legacyOut.results.some((r) => r.legacyKey === true), 'F3 旧 3 段键**回退可读**（legacyKey:true ⇒ force 语义不被绕过）', legacyOut.results.map((r) => r.legacyKey), '<含 true>')
}

console.log('\n== t43/G2+G4 signRequestPlan：锚点形状（POST + form-urlencoded body）+ 向后兼容 ==')
{
  const roles = [
    { gameKey: 'bh3', region: 'bb01', gameUid: '110004211' },
    { gameKey: 'bh3', region: 'pc01', gameUid: '272138868' },
    { gameKey: 'hk4e', region: 'cn_gf01', gameUid: '107630527' },
    { gameKey: 'bbs', region: '', gameUid: '' },
  ]
  const groups = groupsFromAccounts([{ accountKey: 'acct-***4321', uid: '10004321', roles }], { bbsEnabled: true })
  check(groups.every((g) => g.gameKey === 'bbs' || (typeof g.gameUid === 'string' && g.gameUid.length > 0)), 'F9 `groupsFromAccounts` 带出角色的 `gameUid`（uid 取值来源）', groups.map((g) => g.gameKey + ':' + (g.gameUid || '-')), '<非 bbs 都有 gameUid>')

  const ep = JSON.parse(ENDPOINT_TABLE)
  ep.endpoints.hk4e.bodyParams = ['act_id', 'lang', 'uid', 'region']
  ep.endpoints.hk4e.lang = 'zh-cn'
  ep.endpoints.bh3.bodyParams = ['act_id', 'lang', 'uid', 'region']
  ep.endpoints.bh3.lang = 'zh-cn'
  ep.endpoints.bbs = { host: 'bbs-api.mihoyo.com', signPath: '/apihub/app/api/signIn', actId: '', bodyParams: [] }
  const today2 = localDateOf(1700000000000)
  const p = signRequestPlan(ep, groups, today2)
  console.log('  G2 plan => ok=' + p.ok + ' missing=' + JSON.stringify(p.missing))
  p.requests.forEach((r) => console.log('    ' + r.gameKey + ' ' + r.method + ' ' + r.path + '  body=' + String(r.body) + '  ct=' + String(r.contentType)))
  check(p.ok === true && p.missing.length === 0, 'F11/G2 含 bbs 的 groups ⇒ `ok:true` 且 `missing` 不含 bbs', { ok: p.ok, missing: p.missing }, { ok: true, missing: [] })

  // t45：锚点形状 —— 四参数进 **JSON body**（`_mys_request` 用 `json=data`），URL **不带**它们
  const bh3bb01 = p.requests.find((r) => r.comboKey === 'bh3:bb01')
  check(bh3bb01.method === 'POST', 'G2 `method:"POST"`', bh3bb01.method, 'POST')
  check(bh3bb01.path === '/event/luna/bh3/sign', 'G2/G4 `path` **不含** act_id/lang/uid/region（裸签名路径）', bh3bb01.path, '/event/luna/bh3/sign')
  check(bh3bb01.body === '{"act_id":"e202306201626331","lang":"zh-cn","uid":"110004211","region":"bb01"}', 't45 `BODY` 为 **JSON** 逐字（对齐锚点 `json=data`）', bh3bb01.body, '<四键 JSON>')
  check(JSON.stringify(Object.keys(JSON.parse(bh3bb01.body)).sort()) === JSON.stringify(['act_id', 'lang', 'region', 'uid']), 't45 `BODY` 键集合**恰为** [act_id, lang, uid, region]（无多余键）', Object.keys(JSON.parse(bh3bb01.body)), '<四键>')
  check(bh3bb01.contentType === 'application/json', 't45 `contentType:"application/json"`（t43 的 form 判读已纠正）', bh3bb01.contentType, 'application/json')
  const hk4e = p.requests.find((r) => r.gameKey === 'hk4e')
  const hk4eBody = JSON.parse(hk4e.body)
  check(hk4eBody.uid === '107630527' && hk4eBody.region === 'cn_gf01' && hk4e.path.indexOf('uid=') < 0, 'G4 `uid`/`region` 取自**该角色**且**只出现在 body**（URL 里没有）', { body: hk4e.body, path: hk4e.path }, '<body 有 / path 无>')
  // t45：编码由端点表声明（`bodyFormat`）——`form` 可显式覆盖回 t43 行为
  const formEp = JSON.parse(ENDPOINT_TABLE)
  formEp.endpoints.hk4e.bodyParams = ['act_id', 'lang', 'uid', 'region']
  formEp.endpoints.hk4e.lang = 'zh-cn'
  formEp.endpoints.hk4e.bodyFormat = 'form'
  const pForm = signRequestPlan(formEp, groups.filter((g) => g.gameKey === 'hk4e'), today2)
  check(pForm.requests[0].contentType === 'application/x-www-form-urlencoded' && pForm.requests[0].body.indexOf('act_id=') === 0, 't45 `bodyFormat:"form"` ⇒ 可显式覆盖为 form-urlencoded（编码由表声明）', pForm.requests[0].contentType, 'application/x-www-form-urlencoded')
  const bbsReq = p.requests.find((r) => r.gameKey === 'bbs')
  check(bbsReq.path === '/apihub/app/api/signIn' && bbsReq.body === undefined && bbsReq.contentType === null, 'F11/G2 bbs：无 query、无 body、无 contentType（`bodyParams: []`，未臆造 act_id）', { path: bbsReq.path, body: bbsReq.body }, '<无 body>')

  // G2 向后兼容①：未声明 bodyParams ⇒ 旧行为（仅 act_id 入 query、无 body）
  const legacyEp = JSON.parse(ENDPOINT_TABLE)
  const pLegacy = signRequestPlan(legacyEp, groups.filter((g) => g.gameKey !== 'bbs'), today2)
  check(pLegacy.ok === true && /^\?act_id=[^&]+$/.test(pLegacy.requests[0].path.slice(pLegacy.requests[0].path.indexOf('?'))) && pLegacy.requests[0].body === undefined, 'G2 未声明 `bodyParams` ⇒ **退回旧行为**（仅 `act_id` 入 query、无 body）', { path: pLegacy.requests[0].path, body: pLegacy.requests[0].body }, '<旧行为>')
  // G2 向后兼容②：过渡期 `signParams`（t41）仍可用（query），但**本仓数据面已迁到 bodyParams**
  const transEp = JSON.parse(ENDPOINT_TABLE)
  transEp.endpoints.hk4e.signParams = ['act_id', 'lang']
  transEp.endpoints.hk4e.lang = 'zh-cn'
  const pTrans = signRequestPlan(transEp, groups.filter((g) => g.gameKey === 'hk4e'), today2)
  const transQuery = Object.fromEntries(pTrans.requests[0].path.split('?')[1].split('&').map((kv) => kv.split('=')))
  check(JSON.stringify(transQuery) === JSON.stringify({ lang: 'zh-cn', act_id: 'e202311201442471' }) && pTrans.requests[0].body === undefined, 'G2 过渡期 `signParams`（t41）仍按旧语义走 query（向后兼容；数据面已不用它）', transQuery, { lang: 'zh-cn', act_id: 'e202311201442471' })
  // 非 bbs 缺 actId 仍硬校验
  const noAct = JSON.parse(ENDPOINT_TABLE)
  noAct.endpoints.bh3.bodyParams = ['uid', 'region']
  delete noAct.endpoints.bh3.actId
  const pNoAct = signRequestPlan(noAct, [{ accountKey: 'A', gameKey: 'bh3', region: 'bb01', gameUid: '1', comboKey: 'bh3:bb01' }], today2)
  check(pNoAct.ok === false && pNoAct.missing.length === 1 && pNoAct.missing[0].indexOf('缺 actId') > 0, 'F11 非 bbs 目标缺 `actId` ⇒ 仍然硬校验拒绝（只有 bbs 豁免）', pNoAct.missing, '<缺 actId>')
}

console.log('\n== t43/G3 端口 body/contentType 能力（最小 additive，默认不带） ==')
{
  const calls = []
  const t = async (url, init) => { calls.push({ url, init }); return { status: 200, text: async () => '{"retcode":0,"message":"OK"}' } }
  const port = createHttpPort({ transport: t, salts: { active: { appVersion: '2.109.0', clientType: '5' }, entries: { '2.109.0': { salt: SALT32, status: 'verified', clientType: '5' } }, versionCache: null }, credential: FAKE_CRED })
  const r1 = await port.request({ path: '/x', method: 'POST', target: 'hk4e', body: 'a=1&b=2', contentType: 'application/x-www-form-urlencoded' })
  check(r1.sent === true && calls[0].init.body === 'a=1&b=2' && calls[0].init.headers['Content-Type'] === 'application/x-www-form-urlencoded', 'G3 传 `body`+`contentType` ⇒ transport 收到 body 与 `Content-Type`', { body: calls[0].init.body, ct: calls[0].init.headers['Content-Type'] }, '<body + CT>')
  calls.length = 0
  const r2 = await port.request({ path: '/x', method: 'POST', target: 'hk4e', body: 'a=1' })
  check(r2.sent === true && calls[0].init.body === 'a=1' && calls[0].init.headers['Content-Type'] === undefined, 'G3 只传 `body` 不传 `contentType` ⇒ **不自动加** `Content-Type`（旧行为逐字不变）', { body: calls[0].init.body, ct: calls[0].init.headers['Content-Type'] }, { body: 'a=1', ct: undefined })
  calls.length = 0
  const r3 = await port.request({ path: '/x', method: 'POST', target: 'hk4e', contentType: 'application/x-www-form-urlencoded' })
  check(r3.sent === true && calls[0].init.body === undefined && calls[0].init.headers['Content-Type'] === undefined, 'G3 **无 body** 时即使传 `contentType` 也不加头（仅在有 body 时生效）', { body: calls[0].init.body, ct: calls[0].init.headers['Content-Type'] }, { body: undefined, ct: undefined })
  calls.length = 0
  const r4 = await port.request({ path: '/x', method: 'POST', target: 'hk4e', body: { a: 1 } })
  check(r4.sent === true && calls[0].init.body === '{"a":1}', 'G3 非字符串 `body` ⇒ 仍按旧行为 `JSON.stringify`', calls[0].init.body, '{"a":1}')
}

console.log('\n== t44/H1–H3 门禁 groups 与 schedule.targets 同源（自 t44 迁移）==')
{
  const TARGETS4 = ['hk4e:cn_gf01', 'hkrpg:prod_gf_cn', 'zzz:prod_gf_cn', 'bh3:bb01']
  const ROLES7 = [
    { gameKey: 'bh3', region: 'bb01', gameUid: '110004211' },
    { gameKey: 'bh3', region: 'pc01', gameUid: '272138868' },
    { gameKey: 'bh3', region: 'android01', gameUid: '630130530' },
    { gameKey: 'hk4e', region: 'cn_gf01', gameUid: '107630527' },
    { gameKey: 'hkrpg', region: 'prod_gf_cn', gameUid: '110289035' },
    { gameKey: 'zzz', region: 'prod_gf_cn', gameUid: '16960752' },
    { gameKey: 'bbs', region: '', gameUid: '' },
  ]
  const mkGateFs = (targets) => mkFs({
    [DIR + '/credentials.json']: CRED_FILE,
    [DIR + '/salts.json']: mkSalts('verified', SALT32),
    [DIR + '/endpoints.json']: ENDPOINT_TABLE,
    [DIR + '/accounts.json']: JSON.stringify({ version: 1, updatedAt: null, accounts: [{ accountKey: 'acct-***4321', uid: '10004321', roles: ROLES7 }] }),
    [DIR + '/settings.json']: JSON.stringify(Object.assign({}, JSON.parse(SETTINGS_FILE), { bbsEnabled: true, schedule: { enabled: false, targets } })),
  })

  // H1/H2：targets=4
  const s4 = await createActions(createCore({ adapterFs: mkGateFs(TARGETS4), now: () => 1700000000000 })).schedule()
  const gateKeys4 = Object.keys(s4.gate.failedByGroup['acct-***4321'] || {}).sort()
  const planCombos4 = (s4.dailyPlan ? s4.dailyPlan.items.map((x) => x.comboKey) : []).sort()
  check(s4.gate.evaluatedGroups === 4, 'H2 targets=4 ⇒ `evaluatedGroups=4`', s4.gate.evaluatedGroups, 4)
  check(s4.gate.totalFailingGroups === 4, 'H2 targets=4 ⇒ `totalFailingGroups=4`（只统计该集合）', s4.gate.totalFailingGroups, 4)
  check(JSON.stringify(gateKeys4) === JSON.stringify(['bh3', 'hk4e', 'hkrpg', 'zzz']), 'H2 `failedByGroup` 无 `bbs`（bh3 为折叠键，代表被选中的 bh3:bb01）', gateKeys4, ['bh3', 'hk4e', 'hkrpg', 'zzz'])
  check(s4.groups.every((g) => g.comboKey !== 'bbs' && g.comboKey !== 'bh3:pc01' && g.comboKey !== 'bh3:android01'), 'H2 门禁 groups 不含 bbs / bh3:pc01 / bh3:android01', s4.groups.map((g) => g.comboKey), '<四个目标>')
  check(JSON.stringify(s4.groups.map((g) => g.comboKey).sort()) === JSON.stringify(planCombos4), 'H1 门禁 groups 的组合集合与 `dailyPlan.items` **逐字一致**', s4.groups.map((g) => g.comboKey).sort(), planCombos4)
  check(Array.isArray(s4.groupsAll) && s4.groupsAll.length === 7, 'H1 `groupsAll` 给全量（7）便于对照审计', s4.groupsAll && s4.groupsAll.length, 7)
  check(s4.groups.length === 4, 'H1 门禁 groups = targets 命中数（4）', s4.groups.length, 4)

  // H2：targets 为空 ⇒ 全部
  const s0 = await createActions(createCore({ adapterFs: mkGateFs([]), now: () => 1700000000000 })).schedule()
  const gateKeys0 = Object.keys(s0.gate.failedByGroup['acct-***4321'] || {}).sort()
  check(s0.gate.evaluatedGroups === 5 && gateKeys0.includes('bbs') && gateKeys0.includes('bh3'), 'H2 targets 空 ⇒ 评估全部（唯一组合 5，含 bbs 与 bh3）', { n: s0.gate.evaluatedGroups, k: gateKeys0 }, '<5 + bbs/bh3>')
  check(s0.groups.length === 7, 'H2 targets 空 ⇒ 门禁 groups = 全量 7 条角色组合', s0.groups.length, 7)

  // H3：过滤后为空 ⇒ 仍硬阻断 G5（fail-closed）
  const sE = await createActions(createCore({ adapterFs: mkGateFs(['nonexistent:xx01']), now: () => 1700000000000 })).schedule()
  check(sE.groups.length === 0 && sE.gate.groupsEmpty === true && sE.gate.hardBlocked === true && sE.gate.hardItems.includes('G5'), 'H3 过滤后集合为空 ⇒ 仍**硬阻断 G5**（不得因过滤放宽）', { n: sE.groups.length, hb: sE.gate.hardBlocked, hi: sE.gate.hardItems }, '<G5 硬阻断>')

  // 交叉断言：index.js 的 targetSelected 与 scheduler.js 逐字同口径
  const cases = [['bh3:bb01', 'bh3:bb01'], ['bh3:pc01', 'bh3:bb01'], ['bh3', 'bh3:pc01'], ['bbs', 'bbs'], ['hk4e:cn_gf01', 'hk4e:cn_gf01'], ['hk4e:cn_gf01', 'hkrpg:prod_gf_cn']]
  check(cases.every(([key, spec]) => targetSelected([spec], key) === schedTargetSelected([spec], key, spec.split(':')[0])), 'H1/H2 两份 `targetSelected` 在 6 组输入上逐字一致', true, true)
  check(targetSelected(['bh3:bb01'], 'bh3:pc01') === false, 'H1/H2 精确匹配：`bh3:bb01` **不**命中 `bh3:pc01`', targetSelected(['bh3:bb01'], 'bh3:pc01'), false)
  check(targetSelected(['bh3'], 'bh3:pc01') === true, 'H1/H2 不带 region 的 spec 命中该游戏全部区服', targetSelected(['bh3'], 'bh3:pc01'), true)
  check(filterGroupsForTargets([{ comboKey: 'bbs', gameKey: 'bbs', region: '' }], { schedule: { targets: [] } }).length === 1, 'H1 targets 空 ⇒ 不过滤（全选）', 1, 1)
}

console.log('\n== t46/J1–J3：认证成功写 credentials.lastOkAt（G1 证据）+ probe 尊重 dryRun ==')
{
  // ---- J1 正侧①：sign 真实成功 ⇒ 写 lastOkAt + configured:true ----------------------------------
  const fsOk = mkFs({ [DIR + '/credentials.json']: CRED_FILE, [DIR + '/endpoints.json']: ENDPOINT_TABLE, [DIR + '/accounts.json']: ACCOUNTS_FILE, [DIR + '/salts.json']: mkSalts('verified', SALT32) })
  const capOk = capturingTransport([{ status: 200, body: '{"retcode":0,"message":"OK","data":{"awards":[]}}' }])
  const aOk = mkCore(fsOk, { transport: capOk.t, salts: null, nowMs: 1700000000000 }).A
  const outOk = await aOk.sign({ dryRun: false })
  const stOk = getFile(fsOk, 'state.json')
  check(outOk.results[0].outcome === 'signed' && outOk.authOk === true, 'J1 sign 成功（signed）⇒ 回执 authOk:true', { o: outOk.results[0].outcome, a: outOk.authOk }, { o: 'signed', a: true })
  check(!!stOk.credentials && typeof stOk.credentials.lastOkAt === 'string' && stOk.credentials.lastOkAt.length > 0, 'J1 sign 成功 ⇒ state.credentials.lastOkAt 已写（G1 转 ok 的唯一证据源）', stOk.credentials, '<lastOkAt 非空>')
  check(stOk.credentials.configured === true, 'J1 sign 成功 ⇒ state.credentials.configured=true', stOk.credentials.configured, true)
  check(stOk.credentials.lastOkAt === outOk.lastOkAt, 'J1 回执 lastOkAt 与落盘值**逐字一致**', outOk.lastOkAt, stOk.credentials.lastOkAt)
  check(!JSON.stringify(stOk.credentials).includes(FAKE_CRED), 'J1 lastOkAt 记录不含凭据任何片段', JSON.stringify(stOk.credentials).includes(FAKE_CRED), false)

  // ---- J1 正侧②：already（服务端说今天签过了）也算「已被服务端接受」 ------------------------------
  const fsAl = mkFs({ [DIR + '/credentials.json']: CRED_FILE, [DIR + '/endpoints.json']: ENDPOINT_TABLE, [DIR + '/accounts.json']: ACCOUNTS_FILE, [DIR + '/salts.json']: mkSalts('verified', SALT32) })
  const aAl = mkCore(fsAl, { transport: capturingTransport([{ status: 200, body: '{"retcode":-5003,"message":"今天已经签到过啦"}' }]).t, salts: null, nowMs: 1700000000000 }).A
  const outAl = await aAl.sign({ dryRun: false })
  const stAl = getFile(fsAl, 'state.json')
  check(outAl.results[0].outcome === 'already' && outAl.authOk === true && typeof stAl.credentials.lastOkAt === 'string', 'J1 already（服务端已接受）⇒ 同样写 lastOkAt', { o: outAl.results[0].outcome, a: outAl.authOk, t: stAl.credentials.lastOkAt }, '<already/true/非空>')

  // ---- J2 负侧①：sign 失败（AUTH_INVALID）⇒ **不写**、保持原值 ------------------------------------
  const PRE = '2026-01-01T00:00:00.000Z'
  const stPre = jsonStateWithDoneKey('x', { status: 'failed' })
  const fsBad = mkFs({
    [DIR + '/credentials.json']: CRED_FILE, [DIR + '/endpoints.json']: ENDPOINT_TABLE, [DIR + '/accounts.json']: ACCOUNTS_FILE,
    [DIR + '/salts.json']: mkSalts('verified', SALT32),
    [DIR + '/state.json']: JSON.parse(stPre) && JSON.stringify(Object.assign(JSON.parse(stPre), { credentials: { configured: true, lastOkAt: PRE } })),
  })
  const aBad = mkCore(fsBad, { transport: capturingTransport([{ status: 200, body: '{"retcode":-100,"message":"登录状态失效"}' }]).t, salts: null, nowMs: 1700000000000 }).A
  const outBad = await aBad.sign({ dryRun: false })
  const stBad = getFile(fsBad, 'state.json')
  check(outBad.results[0].outcome === 'failed' && outBad.authOk === false, 'J2 sign 失败 ⇒ 回执 authOk:false', { o: outBad.results[0].outcome, a: outBad.authOk }, { o: 'failed', a: false })
  check(stBad.credentials.lastOkAt === PRE, 'J2 sign 失败 ⇒ lastOkAt **保持原值**（不被失败污染）', stBad.credentials.lastOkAt, PRE)

  // ---- J2 负侧②：dryRun（本地判定，未出站）⇒ 同样不写 ---------------------------------------------
  const fsDry = mkFs({ [DIR + '/credentials.json']: CRED_FILE, [DIR + '/endpoints.json']: ENDPOINT_TABLE, [DIR + '/accounts.json']: ACCOUNTS_FILE, [DIR + '/salts.json']: mkSalts('verified', SALT32) })
  await mkCore(fsDry, { salts: null, nowMs: 1700000000000 }).A.sign({})
  const stDry = getFile(fsDry, 'state.json')
  check(!stDry.credentials || stDry.credentials.lastOkAt === undefined || stDry.credentials.lastOkAt === null, 'J2 dryRun（零出站）⇒ 不写 lastOkAt', stDry.credentials, '<null/undefined>')

  // ---- J1 正侧③：accounts{refresh:true} 成功 ⇒ 写 lastOkAt ----------------------------------------
  const ROLES = JSON.stringify({ retcode: 0, message: 'OK', data: { list: [{ game_biz: 'hk4e_cn', region: 'cn_gf01', game_uid: '100000001', nickname: 'n', level: 60, uid: '10004321' }] } })
  const fsAcc = mkFs({ [DIR + '/credentials.json']: CRED_FILE, [DIR + '/salts.json']: mkSalts('verified', SALT32), [DIR + '/state.json']: JSON.stringify(Object.assign(JSON.parse(jsonStateWithDoneKey('x', { status: 'failed' })), { credentials: { configured: true, lastOkAt: null } })) })
  const aAcc = mkCore(fsAcc, { transport: capturingTransport([{ status: 200, body: ROLES }]).t, salts: null, nowMs: 1700000000000 }).A
  const outAcc = await aAcc.accounts({ refresh: true })
  const stAcc = getFile(fsAcc, 'state.json')
  check(outAcc.authOk === true && typeof outAcc.lastOkAt === 'string', 'J1 accounts{refresh:true} 成功 ⇒ 回执 authOk:true + lastOkAt', { a: outAcc.authOk, t: outAcc.lastOkAt }, '<true/非空>')
  check(stAcc.credentials.configured === true && stAcc.credentials.lastOkAt === outAcc.lastOkAt, 'J1 accounts 成功 ⇒ 落盘 lastOkAt 与回执一致（G1 转 ok）', stAcc.credentials, '<与回执一致>')

  // ---- J2 负侧③：accounts refresh 失败（登录态失效）⇒ 不写 ----------------------------------------
  const fsAccBad = mkFs({ [DIR + '/credentials.json']: CRED_FILE, [DIR + '/salts.json']: mkSalts('verified', SALT32), [DIR + '/state.json']: JSON.stringify(Object.assign(JSON.parse(jsonStateWithDoneKey('x', { status: 'failed' })), { credentials: { configured: true, lastOkAt: PRE } })) })
  const aAccBad = mkCore(fsAccBad, { transport: capturingTransport([{ status: 200, body: '{"retcode":-100,"message":"登录状态失效"}' }]).t, salts: null, nowMs: 1700000000000 }).A
  const outAccBad = await aAccBad.accounts({ refresh: true })
  check(outAccBad.authOk === false && getFile(fsAccBad, 'state.json').credentials.lastOkAt === PRE, 'J2 accounts 失败 ⇒ authOk:false 且 lastOkAt 保持原值', { a: outAccBad.authOk, t: getFile(fsAccBad, 'state.json').credentials.lastOkAt }, { a: false, t: PRE })

  // ---- J3：probe 尊重 dryRun（**负向断言：省略/true ⇒ transport 调用数 = 0**） ---------------------
  check(bizOfGameKey('hk4e') === 'hk4e_cn' && bizOfGameKey('zzz') === 'nap_cn' && bizOfGameKey('bbs') === null, 'J3 §2.2 反查表：hk4e→hk4e_cn / zzz→nap_cn / 未知⇒null（不编造）', [bizOfGameKey('hk4e'), bizOfGameKey('zzz'), bizOfGameKey('bbs')], ['hk4e_cn', 'nap_cn', null])
  const fsPr = mkFs({ [DIR + '/credentials.json']: CRED_FILE, [DIR + '/endpoints.json']: ENDPOINT_TABLE, [DIR + '/salts.json']: mkSalts('verified', SALT32) })
  const capPr = capturingTransport([{ status: 200, body: '{"retcode":0}' }])
  const aPr = mkCore(fsPr, { transport: capPr.t, salts: null, nowMs: 1700000000000 }).A
  const pDefault = await aPr.miyoushe_probe({})
  check(capPr.calls.length === 0, 'J3 probe 省略 dryRun ⇒ **只构造请求、不发送**（transport 调用数 = 0）', capPr.calls.length, 0)
  check(pDefault.ok === true && pDefault.sent === false && pDefault.dryRun === true, 'J3 省略 dryRun ⇒ 视作 true 且回执 sent:false', { ok: pDefault.ok, sent: pDefault.sent, dry: pDefault.dryRun }, { ok: true, sent: false, dry: true })
  check(typeof pDefault.url === 'string' && pDefault.url.includes('/event/luna/info?act_id=e202311201442471&game_biz=hk4e_cn'), 'J3 预览 URL = 真实形状（act_id 取端点表 + game_biz 取 §2.2 反查）', pDefault.url, '<含 /event/luna/info?act_id=…&game_biz=hk4e_cn>')
  check(pDefault.missingParams.length === 0 && pDefault.method === 'GET' && Array.isArray(pDefault.headersPlanned) && pDefault.headersPlanned.length > 0, 'J3 预览含 method/计划头名/无缺参', { m: pDefault.missingParams, method: pDefault.method, h: pDefault.headersPlanned.length }, '<[]/GET/>0>')
  const pTrue = await aPr.miyoushe_probe({ dryRun: true })
  check(capPr.calls.length === 0 && pTrue.sent === false, 'J3 probe{dryRun:true} ⇒ 仍然零出站（显式 true 与省略同效）', capPr.calls.length, 0)
  const pBbs = await aPr.miyoushe_probe({ target: 'bbs', dryRun: true })
  check(capPr.calls.length === 0 && pBbs.missingParams.join(',') === 'act_id,game_biz', 'J3 bbs 无 actId/gameBiz ⇒ **不编造**，如实列入 missingParams（仍零出站）', { calls: capPr.calls.length, m: pBbs.missingParams }, { calls: 0, m: ['act_id', 'game_biz'] })
  const pReal = await aPr.miyoushe_probe({ dryRun: false })
  check(capPr.calls.length === 1 && pReal.sent === true && pReal.dryRun === false, 'J3 probe{dryRun:false} ⇒ **才真实发送一次**', { calls: capPr.calls.length, sent: pReal.sent }, { calls: 1, sent: true })
  check(String(pReal.endpoint || '').indexOf('/event/luna/info') >= 0, 'J3 真发时端点即 /event/luna/info', pReal.endpoint, '<含 /event/luna/info>')

  // ---- J1 纯函数 withAuthOk：幂等 + 保留其它凭据字段 ----------------------------------------------
  const wa = withAuthOk({ credentials: { configured: true, uidTail: '***4321', lastOkAt: null }, doneKeys: {} }, '2026-09-20T00:00:00.000Z')
  check(wa.credentials.lastOkAt === '2026-09-20T00:00:00.000Z' && wa.credentials.uidTail === '***4321' && wa.credentials.configured === true, 'J1 withAuthOk 只改 lastOkAt/configured，保留其它字段（纯函数）', wa.credentials, '<lastOkAt/uidTail/configured 齐>')
  check(JSON.stringify(wa.doneKeys) === '{}', 'J1 withAuthOk 不动其它 state 子树', wa.doneKeys, {})
}

console.log('\n== t52/Q1+Q2 凭据写入通道（D-3 未尽项）：set/clear 落盘 + 只进不出 ==')
{
  const MS = 1700000000000
  const { readFileSync } = await import('node:fs')
  const FAKE_CRED2 = FAKE_CRED + '; uid_key=123456789' // 合成凭据（**不是**真实凭据；带一个数字型账号标识供启发式提取）
  // ---- 落盘层（与 apply 注入的端口同源实现） ----
  const fsC = mkFs({})
  const coreC = createCore({ adapterFs: fsC, now: () => MS, version: '0.1.0' })
  const r = await writeCredentialToStore(coreC, FAKE_CRED2)
  const file = getFile(fsC, 'credentials.json')
  const stC = getFile(fsC, 'state.json')
  console.log('  set => ' + JSON.stringify({ uidTail: r.uidTail, accounts: file.accounts.length, configured: stC.credentials.configured, lastOkAt: stC.credentials.lastOkAt }))
  check(file.version === 1 && file.accounts.length === 1 && file.accounts[0].credential === FAKE_CRED2, 'Q1 set ⇒ 凭据**原值**落盘（形状沿用 t31 定形：签名需要原值）', { v: file.version, n: file.accounts.length, same: file.accounts[0].credential === FAKE_CRED2 }, { v: 1, n: 1, same: true })
  check(file.accounts[0].uid === '123456789' && file.accounts[0].accountKey === 'acct-***6789' && r.uidTail === '***6789', 'Q1 uid 由「数字型账号标识」启发式提取；accountKey 只存**尾号形态**', { uid: file.accounts[0].uid, ak: file.accounts[0].accountKey, tail: r.uidTail }, { uid: '123456789', ak: 'acct-***6789', tail: '***6789' })
  const fsNoUid = mkFs({})
  const rNoUid = await writeCredentialToStore(createCore({ adapterFs: fsNoUid, now: () => MS, version: '0.1.0' }), FAKE_CRED)
  check(getFile(fsNoUid, 'credentials.json').accounts[0].uid === null && getFile(fsNoUid, 'credentials.json').accounts[0].accountKey === null && rNoUid.uidTail === null, 'Q1 凭据里没有数字型标识 ⇒ uid/accountKey 记 `null`（**不编造**）', { uid: getFile(fsNoUid, 'credentials.json').accounts[0].uid, tail: rNoUid.uidTail }, { uid: null, tail: null })
  check(stC.credentials.configured === true && stC.credentials.lastOkAt === null, 'Q1 set ⇒ 同步 state.credentials（**轮换即 lastOkAt 归零**：新凭据尚未被服务端证明 ⇒ fail-closed）', stC.credentials, '<configured:true / lastOkAt:null>')
  check(uidFromCredentialString('x=1; uid_key=123456789; y=2') === '123456789' && uidFromCredentialString('no-numeric-here') === null, 'Q1 uid 启发式：优先「键名以 uid 结尾」的数字值；取不到 ⇒ null（**不编造**）', [uidFromCredentialString('x=1; uid_key=123456789; y=2'), uidFromCredentialString('no-numeric-here')], ['123456789', null])
  // ---- A.credentials 全链路（注入与 apply 同源的 store 端口） ----
  const fsA = mkFs({})
  const coreA = createCore({ adapterFs: fsA, now: () => MS, version: '0.1.0' })
  const A2 = createActions(createCore({ adapterFs: fsA, now: () => MS, version: '0.1.0', credentialsPort: { set: (raw, o) => writeCredentialToStore(coreA, raw, o), clear: () => clearCredentialInStore(coreA) } }))
  const setRes = await A2.credentials({ action: 'set', cookie: FAKE_CRED }) // discipline-exempt: 设计规定的入参名: miyoushe_credentials 的 cookie 入参（自测夹具，非真实凭据）
  const setKeys = Object.keys(setRes).sort().join(',')
  console.log('  A.credentials{set} => ' + JSON.stringify({ ok: setRes.ok, configured: setRes.configured, uidTail: setRes.uidTail, lastOkAt: setRes.lastOkAt, keys: setKeys }))
  check(setRes.ok === true && setRes.configured === true, 'Q1 `miyoushe_credentials{set}` **不再 NOT_READY**（写入通道已接线）', { ok: setRes.ok, cfg: setRes.configured }, { ok: true, cfg: true })
  check(setKeys === 'action,configured,lastOkAt,ok,uidTail,warning', 'Q2 回执字段**恰好**只有 ok/action/configured/uidTail/lastOkAt/warning', setKeys, 'action,configured,lastOkAt,ok,uidTail,warning')
  check(!JSON.stringify(setRes).includes(FAKE_CRED), 'Q2 写入回执**不含**凭据值', JSON.stringify(setRes).includes(FAKE_CRED), false)
  const clr = await A2.credentials({ action: 'clear' })
  const stA = getFile(fsA, 'state.json')
  console.log('  A.credentials{clear} => ' + JSON.stringify({ ok: clr.ok, configured: clr.configured, removed: clr.removed }))
  check(clr.ok === true && clr.configured === false, 'Q1 `clear` ⇒ configured:false（且如实回 `removed`，不谎报"已删除文件"）', { ok: clr.ok, cfg: clr.configured, removed: clr.removed }, '<ok/configured:false>')
  check(stA.credentials.configured === false && typeof stA.credentials.clearedAt === 'string', 'Q1 clear ⇒ 同步 state.credentials（含 clearedAt 显式否定）', stA.credentials, '<configured:false / clearedAt>')
  check(credentialConfiguredOf({ configured: true }, { configured: false, clearedAt: '2026-09-20T00:00:00.000Z' }) === false && credentialConfiguredOf({ configured: true }, {}) === true, 'Q1 判据：**显式否定优先**（文件仍在但已 clear ⇒ configured:false）；无否定时仍按"文件存在 ∨ state"', 'see-expr', '<false / true>')
  const afterClear = await coreA.store.readCredentials()
  check(!afterClear || !afterClear.primary, 'Q1 clear 后 `readCredentials().primary === null` ⇒ 出站将按 AUTH_REQUIRED 处理（真的"没凭据"）', afterClear && afterClear.primary, null)
  const badAction = await A2.credentials({ action: 'nope' })
  const badEmpty = await A2.credentials({ action: 'set', cookie: '' })
  check(badAction.ok === false && badAction.error.code === 'BAD_ARG' && !JSON.stringify(badAction).includes(FAKE_CRED), 'Q2 非法 action ⇒ strict 错误分支，且不含凭据片段', badAction.error && badAction.error.code, 'BAD_ARG')
  check(badEmpty.ok === false && badEmpty.error.code === 'BAD_ARG' && !JSON.stringify(badEmpty).includes(FAKE_CRED), 'Q2 空凭据入参 ⇒ strict 错误分支，且不含凭据片段', badEmpty.error && badEmpty.error.code, 'BAD_ARG')
  const A3 = createActions(createCore({ adapterFs: mkFs({}), now: () => MS, version: '0.1.0' }))
  const noPort = await A3.credentials({ action: 'set', cookie: FAKE_CRED }) // discipline-exempt: 设计规定的入参名: miyoushe_credentials 的 cookie 入参（自测夹具，非真实凭据）
  check(noPort.ok === false && noPort.error.code === 'NOT_READY', 'Q1 **未注入**端口 ⇒ 仍 NOT_READY（生产由 apply 注入；S1 口径未放宽）', noPort.error && noPort.error.code, 'NOT_READY')
  const srcIdx = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  check(srcIdx.includes('const storeCredPort') && srcIdx.includes('writeCredentialToStore(core0') && srcIdx.includes('clearCredentialInStore(core0'), 'Q1 静态：`apply` 注入 store 落盘端口（storeCredPort → write/clearCredentialInStore）', '<源码含三处>', '<含>')
}

console.log('\n== t52/Q3 受控维护/清理（精确匹配 + 审计日志 + 拒绝通配/批量）==')
{
  const MS = Date.parse('2026-09-20T08:00:00.000Z')
  const today = localDateOf(MS)
  const T_KEY = 'acct-***4321:hk4e:' + today + ':cn_gf01'
  const Y_KEY = 'acct-***4321:hk4e:2026-01-01:cn_gf01'
  const OTHER = 'acct-***4321:zzz:' + today + ':prod_gf_cn'
  const mkM = () => mkFs({
    [DIR + '/state.json']: JSON.stringify({
      version: 1, schedule: { enabled: false, mode: 'readonly', nextAt: null, lastRunAt: null, pausedBy: null },
      credentials: { configured: true, lastOkAt: '2026-09-20T07:00:00.000Z' },
      doneKeys: { [T_KEY]: { status: 'failed', retcode: -5003, at: '2026-09-20T07:00:00.000Z' }, [Y_KEY]: { status: 'failed', retcode: -100, at: '2026-01-01T00:00:00.000Z' }, [OTHER]: { status: 'signed', retcode: 0, at: '2026-09-20T07:05:00.000Z' } },
      lastSignSuccess: {}, lock: null,
    }),
  })
  const fsM = mkM()
  const AM = createActions(createCore({ adapterFs: fsM, now: () => MS, version: '0.1.0' }))
  const mres = await AM.config({ patch: { maintenance: { clearDoneKeys: [{ accountKey: 'acct-***4321', gameKey: 'hk4e', region: 'cn_gf01' }], reason: 't52 自测：清理当日失败键' } } })
  const stM = getFile(fsM, 'state.json')
  console.log('  maintenance => ' + JSON.stringify({ ok: mres.ok, cleared: mres.clearedKeys, count: mres.clearedCount, notFound: mres.notFound }))
  check(mres.ok === true && mres.clearedCount === 1 && mres.clearedKeys[0] === T_KEY, 'Q3 精确匹配（accountKey+gameKey+region）⇒ 只清**那一条当日**键', { n: mres.clearedCount, k: mres.clearedKeys[0] }, { n: 1, k: T_KEY })
  check(stM.doneKeys[T_KEY] === undefined && !!stM.doneKeys[Y_KEY] && !!stM.doneKeys[OTHER], 'Q3 **只删当日**、**不碰**历史键与其它组合（护栏：不做批量清空）', Object.keys(stM.doneKeys), [Y_KEY, OTHER])
  const logText = Array.from(fsM.files.values()).filter((v) => typeof v === 'string' && v.includes('maintenance')).join('\n')
  console.log('  audit => ' + logText.slice(0, 160))
  check(logText.includes('"event":"maintenance"') && logText.includes('t52 自测：清理当日失败键') && !logText.includes(FAKE_CRED), 'Q3 **必须写审计日志**（event:maintenance + reason；**不含凭据**）', { hasEvent: logText.includes('"event":"maintenance"'), hasReason: logText.includes('清理当日失败键'), leak: logText.includes(FAKE_CRED) }, { hasEvent: true, hasReason: true, leak: false })
  const m2 = await AM.config({ patch: { maintenance: { resetLastOkAt: true, reason: '重置以复验 G1' } } })
  check(m2.ok === true && m2.resetLastOkAt === true && getFile(fsM, 'state.json').credentials.lastOkAt === null, 'Q3 ② 按需重置 `state.credentials.lastOkAt`', getFile(fsM, 'state.json').credentials.lastOkAt, null)
  const rej = [
    ['通配 accountKey', { clearDoneKeys: [{ accountKey: '*', gameKey: 'hk4e' }], reason: 'x123' }],
    ['通配 gameKey=all', { clearDoneKeys: [{ accountKey: 'acct-***4321', gameKey: 'all' }], reason: 'x123' }],
    ['缺 reason', { clearDoneKeys: [{ accountKey: 'acct-***4321', gameKey: 'hk4e' }] }],
    ['超上限（9 条）', { clearDoneKeys: new Array(9).fill({ accountKey: 'acct-***4321', gameKey: 'hk4e' }), reason: 'x123' }],
    ['未知子键', { clearDoneKeys: [{ accountKey: 'acct-***4321', gameKey: 'hk4e' }], reason: 'x123', all: true }],
  ]
  for (const [label, body] of rej) {
    const r = await AM.config({ patch: { maintenance: body } })
    check(r.ok === false && r.error.code === 'BAD_ARG', 'Q3 拒绝用例：' + label + ' ⇒ BAD_ARG（fail-closed）', r.ok === false ? r.error.code : r.ok, 'BAD_ARG')
  }
  const mixed = await AM.config({ patch: { maintenance: { resetLastOkAt: true, reason: 'x123' }, windowStart: '09:00' } })
  check(mixed.ok === false && mixed.error.code === 'BAD_ARG', 'Q3 maintenance 不得与其它配置键同批（互斥）', mixed.error && mixed.error.code, 'BAD_ARG')
  check(Boolean(validateMaintenance({ clearDoneKeys: [{ accountKey: 'a', gameKey: 'b' }], reason: 'ok-理由' }).ok), 'Q3 校验器（纯函数）合法入参 ⇒ ok', true, true)
}

console.log('\n== t52/G2c 读侧回填：只在「记录时间戳 ≥ active.verifiedAt」时补 lastSignSuccess ==')
{
  const A = 'acct-***4321'
  const SALTS = { active: { appVersion: '2.109.0', clientType: '5' }, entries: { '2.109.0': { status: 'verified', saltFingerprint: 'fpA', verifiedAt: '2026-09-20T06:30:28.450Z' } } }
  const today = localDateOf(Date.parse('2026-09-20T08:00:00.000Z'))
  const k = A + ':hk4e:' + today + ':cn_gf01'
  const base = (at, prev) => ({
    doneKeys: { [k]: { status: 'already', at, retcode: -5003 } },
    lastSignSuccess: { [A]: { hk4e: Object.assign({ outcome: 'success', at: '2026-09-20T06:18:11.307Z', retcode: 0 }, prev) } },
  })
  const pos = backfillSameSaltSuccess(base('2026-09-20T07:03:34.654Z', { saltFingerprint: null, appVersion: null }), SALTS, { now: Date.parse('2026-09-20T08:00:00.000Z') })
  console.log('  正（at ≥ verifiedAt）=> ' + JSON.stringify(pos.filled))
  check(pos.filled.length === 1 && pos.state.lastSignSuccess[A].hk4e.saltFingerprint === 'fpA' && pos.state.lastSignSuccess[A].hk4e.appVersion === '2.109.0', 'G2c **正**：doneKey.at ≥ verifiedAt ⇒ 回填当前盐指纹/版本', pos.state.lastSignSuccess[A].hk4e, '<fpA/2.109.0>')
  check(pos.state.lastSignSuccess[A].hk4e.outcome === 'already' && pos.state.doneKeys[k].status === 'already', 'G2c **护栏**：`outcome` 保持 already、**不改** doneKeys（含 status）', { o: pos.state.lastSignSuccess[A].hk4e.outcome, s: pos.state.doneKeys[k].status }, { o: 'already', s: 'already' })
  const neg1 = backfillSameSaltSuccess(base('2026-09-20T06:00:00.000Z', { saltFingerprint: null, appVersion: null }), SALTS, { now: Date.parse('2026-09-20T08:00:00.000Z') })
  check(neg1.filled.length === 0 && neg1.state.lastSignSuccess[A].hk4e.saltFingerprint === null, 'G2c **负①**：doneKey.at **早于** verifiedAt ⇒ **不回填**（该请求未必用当前盐）', neg1.filled.length, 0)
  const noVer = backfillSameSaltSuccess(base('2026-09-20T07:03:34.654Z', { saltFingerprint: null, appVersion: null }), { active: { appVersion: '2.109.0' }, entries: { '2.109.0': { status: 'verified', saltFingerprint: 'fpA' } } }, { now: Date.parse('2026-09-20T08:00:00.000Z') })
  check(noVer.filled.length === 0, 'G2c **负②**：`verifiedAt` 缺失 ⇒ **一律不回填**（不猜测、不伪造）', noVer.filled.length, 0)
  const yKey = A + ':hk4e:2026-01-01:cn_gf01'
  const other = { doneKeys: { [yKey]: { status: 'already', at: '2026-01-01T07:00:00.000Z', retcode: -5003 } }, lastSignSuccess: { [A]: { hk4e: { outcome: 'success', at: '2026-01-01T07:00:00.000Z', retcode: 0, saltFingerprint: null, appVersion: null } } } }
  check(backfillSameSaltSuccess(other, SALTS, { now: Date.parse('2026-09-20T08:00:00.000Z') }).filled.length === 0, 'G2c **负③**：非**当日**记录 ⇒ 不回填', 0, 0)
  const again = backfillSameSaltSuccess(pos.state, SALTS, { now: Date.parse('2026-09-20T08:00:00.000Z') })
  check(again.filled.length === 0, 'G2c **幂等**：已同源 ⇒ 再跑不再回填（不会反复写审计日志）', again.filled.length, 0)
}

console.log('\n== 哨兵：全程零真实网络 ==')
{
  const realFetch = globalThis.fetch
  let guard = 0
  try {
    globalThis.fetch = () => { guard++; throw new Error('REAL_NETWORK_ATTEMPT_BLOCKED') }
    const fs = mkFs({ [DIR + '/credentials.json']: CRED_FILE, [DIR + '/endpoints.json']: ENDPOINT_TABLE, [DIR + '/accounts.json']: ACCOUNTS_FILE, [DIR + '/salts.json']: mkSalts('verified', SALT32) })
    const { A } = mkCore(fs, { transport: capturingTransport([{ status: 200, body: '{"retcode":0}' }]).t, salts: null, nowMs: 1700000000000 })
    await A.sign({ dryRun: false })
    check(guard === 0, '**零真实网络**：本套件全程 globalThis.fetch 哨兵调用数 = 0', guard, 0)
  } finally { globalThis.fetch = realFetch }
}

console.log('')
console.log('SIGN_PATH failures=' + failures)
process.exitCode = failures === 0 ? 0 : 1
