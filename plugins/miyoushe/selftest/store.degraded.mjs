// @local/miyoushe —— A3/A6 单测：数据面走 adapterFs + 两条显式降级分支（node 直调，**不加载插件**）
// 运行：node selftest/store.degraded.mjs    （退出码 0 = 全过）
//
// 覆盖：
//  (1) adapterFs 缺失 ⇒ ping ok / status NOT_READY（显式，不静默）
//  (2) 数据目录不存在 ⇒ FS_PARENT_MISSING，且**没有发生任何写入**（证明"不自动建目录"）
//  (3) adapter 根未登记（ROOT_UNKNOWN）⇒ 同样归 FS_PARENT_MISSING
//  (4) 目录存在 ⇒ status ok/ready、骨架字段齐全、nextAt=null；读写与日志**全部**经 fake adapterFs
//  (5) 凭据**只探存在性**：existence 探测发生，readText/readJson **从未**被用于凭据文件
//  (6) 盐表（§3.5.4 版本为键）只出指纹，出口**不含盐明文**
//  (7) 损坏 JSON ⇒ 显式 BAD_ARG（不静默回落默认值把损坏吞掉）
//
// 说明：本测试**只用内存假体**模拟 adapterFs（对外方法子集同 AdapterFsImpl），
//       因此**不碰真实 `E:/DSH工作区/全局数据/miyoushe/`**（该目录当前不存在，本任务也不创建）。

import { createCore } from '../lib/index.js'
import { exitPayload, saltFingerprint } from '../lib/mask.js'
import { localDate } from '../lib/store.js'
import { createHash } from 'node:crypto'

const DATA_ROOT = 'E:/DSH工作区/全局数据'
const MIYOUSHE_DIR = DATA_ROOT + '/miyoushe'
// **纯测试盐**（非真实，参照设计 §3.3 V3 的做法；源码中不落任何真实盐值）
const TEST_SALT = 'TEST-SALT-ONLY-FOR-UNIT-TEST'

let failures = 0
function check(cond, label, got, want) {
  if (cond) console.log('PASS ' + label)
  else { failures++; console.log('FAIL ' + label + ' got=' + JSON.stringify(got) + ' want=' + JSON.stringify(want)) }
}

/** 内存版 adapterFs 假体（对外方法子集同 AdapterFsImpl）；记录每次调用以便审计 */
class MemAdapterFs {
  constructor(opts) {
    const o = opts || {}
    this.roots = o.roots || { 全局数据: DATA_ROOT }
    this.dirs = new Set(o.dirs || [])
    this.files = new Map(Object.entries(o.files || {}))
    this.calls = []
  }
  _p(root, rel) {
    const base = this.roots[root]
    if (base === undefined) { const e = new Error('unknown root: ' + root); e.code = 'ROOT_UNKNOWN'; throw e }
    return rel ? base.replace(/\/+$/, '') + '/' + rel : base
  }
  _rec(op, root, rel) { this.calls.push({ op, root, rel }) }
  _count(op, rel) { return this.calls.filter((c) => c.op === op && (!rel || c.rel === rel)).length }
  async resolve(root, rel) { const p = this._p(root, rel); return { targetKey: p, displayPath: p } }
  async exists(root, rel) { this._rec('exists', root, rel); const p = this._p(root, rel); return this.dirs.has(p) || this.files.has(p) }
  async readText(root, rel) {
    this._rec('readText', root, rel)
    const p = this._p(root, rel)
    if (!this.files.has(p)) { const e = new Error('not found'); e.code = 'FS_NOT_FOUND'; throw e }
    return this.files.get(p)
  }
  async readJson(root, rel) {
    this._rec('readJson', root, rel)
    const t = await this.readText(root, rel)
    try { return JSON.parse(t) } catch (e) { const err = new Error('bad json'); err.code = 'EBADJSON'; throw err }
  }
  async writeText(root, rel, text) {
    this._rec('writeText', root, rel)
    const p = this._p(root, rel)
    const existed = this.files.has(p)
    this.files.set(p, text)
    return { ok: true, operation: existed ? 'update' : 'create' }
  }
  async writeJson(root, rel, data) {
    this._rec('writeJson', root, rel)
    const p = this._p(root, rel)
    const existed = this.files.has(p)
    this.files.set(p, JSON.stringify(data, null, 2))
    return { ok: true, operation: existed ? 'update' : 'create' }
  }
  async listDir(root, rel) {
    this._rec('listDir', root, rel)
    const prefix = this._p(root, rel) + '/'
    const names = new Set()
    for (const f of this.files.keys()) if (f.startsWith(prefix)) names.add(f.slice(prefix.length).split('/')[0])
    return Array.from(names).map((n) => ({ name: n, type: 'file' }))
  }
}

const withDir = (extra) => new MemAdapterFs(Object.assign({
  dirs: [MIYOUSHE_DIR, MIYOUSHE_DIR + '/logs'],
  files: { [MIYOUSHE_DIR + '/logs/.keep']: '' },
}, extra || {}))

console.log('== (1) adapterFs 缺失 ⇒ NOT_READY（显式降级，不静默）==')
{
  const core = createCore({}) // 无 adapterFs
  const ping = await core.ping()
  console.log('ping raw=' + JSON.stringify(ping))
  check(ping.ok === true, 'ping 不依赖数据面 ⇒ ok:true', ping.ok, true)
  check(ping.dataFace === false, 'ping.dataFace=false', ping.dataFace, false)
  const st = await core.status()
  console.log('status raw=' + JSON.stringify(st))
  check(st.ok === false, 'status.ok=false', st.ok, false)
  check(st.error && st.error.code === 'NOT_READY', 'status.error.code=NOT_READY', st.error && st.error.code, 'NOT_READY')
  check(typeof st.error.message === 'string' && st.error.message.length > 0, 'status.error.message 非空（显式告知）', st.error.message, '<non-empty>')
  check(core.store.hasDataFace() === false, 'store.hasDataFace()=false', core.store.hasDataFace(), false)
}

console.log('== (2) 数据目录不存在 ⇒ FS_PARENT_MISSING 且零写入（不自动建目录）==')
{
  const fs = new MemAdapterFs({ roots: { 全局数据: DATA_ROOT } }) // 无 miyoushe 目录
  const core = createCore({ adapterFs: fs })
  const st = await core.status()
  console.log('status raw=' + JSON.stringify(st))
  check(st.ok === false && st.error.code === 'FS_PARENT_MISSING', 'status.error.code=FS_PARENT_MISSING', st.error && st.error.code, 'FS_PARENT_MISSING')
  check(/数据目录不存在/.test(st.error.message), '文案含「数据目录不存在」（§6.1 提示口径）', st.error.message, '<含提示>')
  check(st.error.message.includes(MIYOUSHE_DIR), '提示给出应创建的具体路径', st.error.message, '<含路径>')
  check(fs._count('writeText') === 0 && fs._count('writeJson') === 0, '未发生任何写入（不自动建目录 / 不写半截文件）', { w: fs._count('writeText'), j: fs._count('writeJson') }, { w: 0, j: 0 })
  check(fs.files.size === 0, '假体文件表仍为空', fs.files.size, 0)
  const probe = await core.store.probeDataDir()
  check(probe.ok === false && probe.code === 'FS_PARENT_MISSING', 'store.probeDataDir() 给出结论而不抛', probe, '<FS_PARENT_MISSING>')
  const again = await core.status()
  check(again.error.code === 'FS_PARENT_MISSING', '重复调用仍稳定降级（幂等）', again.error.code, 'FS_PARENT_MISSING')
}

console.log('== (3) ROOT_UNKNOWN（adapter 根未登记）⇒ 归 FS_PARENT_MISSING ==')
{
  const fs = new MemAdapterFs({ roots: { 别的根: 'E:/tmp' }, dirs: [MIYOUSHE_DIR] })
  const core = createCore({ adapterFs: fs })
  const st = await core.status()
  console.log('status raw=' + JSON.stringify(st))
  check(st.ok === false && st.error.code === 'FS_PARENT_MISSING', 'error.code=FS_PARENT_MISSING', st.error && st.error.code, 'FS_PARENT_MISSING')
  check(st.error.detail === 'ROOT_UNKNOWN:全局数据', 'detail 保留原始码便于运维定位', st.error.detail, 'ROOT_UNKNOWN:全局数据')
}

console.log('== (4) 目录存在 ⇒ status 骨架齐全 + 读写/日志全部经 adapterFs ==')
{
  const fs = withDir()
  const core = createCore({ adapterFs: fs, version: '0.1.0' })
  const st = await core.status()
  console.log('status raw=' + JSON.stringify(st))
  check(st.ok === true && st.ready === true, 'status ok/ready', { ok: st.ok, ready: st.ready }, { ok: true, ready: true })
  for (const k of ['ready', 'credentials', 'salts', 'schedule']) {
    check(Object.prototype.hasOwnProperty.call(st, k), 'status 含骨架字段 ' + k, Object.keys(st).join(','), k)
  }
  check(st.salts.status === 'missing' && st.salts.appVersion === null, '无 salts.json ⇒ salts.status=missing（不静默编造）', st.salts.status, 'missing')
  // t16：调度器（§5）已接线 ⇒ `nextAt` 由"窗口起点 + 抖动"解出（**不再是 null**，也**不是**"当前时刻+tickMs"糊弄）
  const nextAtMs = Date.parse(st.schedule.nextAt)
  const nextAtLocal = new Date(nextAtMs)
  check(st.schedule.enabled === false, 'schedule 骨架（未开启）', st.schedule.enabled, false)
  check(typeof st.schedule.nextAt === 'string' && Number.isFinite(nextAtMs), 'nextAt 是合法 ISO（由调度器解出，非 null/非伪造）', st.schedule.nextAt, '<ISO>')
  check(nextAtLocal.getHours() === 8 && nextAtLocal.getMinutes() === 0, 'nextAt 落在配置窗口起点 08:00（本地时区）', nextAtLocal.toTimeString().slice(0, 5), '08:00')
  check(nextAtMs > Date.now() - 60000, 'nextAt 不在过去（窗口语义正确）', st.schedule.nextAt, '> now-60s')
  check(st.schedule.window.start === '08:00' && st.schedule.window.end === '23:30', '默认窗口来自 settings 缺省（§5.1）', st.schedule.window, { start: '08:00', end: '23:30' })
  check(st.credentials.configured === false, 'credentials.configured=false（凭据文件不存在）', st.credentials.configured, false)
  check(fs._count('exists', 'miyoushe/credentials.json') >= 1, '凭据经 exists 探测', fs._count('exists', 'miyoushe/credentials.json'), '>=1')
  check(fs._count('readText', 'miyoushe/credentials.json') === 0 && fs._count('readJson', 'miyoushe/credentials.json') === 0, '凭据文件**从未被读取**（只探存在性，§4.2 规则 2）', { rt: fs._count('readText', 'miyoushe/credentials.json'), rj: fs._count('readJson', 'miyoushe/credentials.json') }, { rt: 0, rj: 0 })

  const w1 = await core.store.writeSettings({ version: 1, tickMs: 30000 })
  const w2 = await core.store.writeState({ version: 1, schedule: { enabled: false, mode: 'readonly', nextAt: null, lastRunAt: null, pausedBy: null }, doneKeys: {}, lastSignSuccess: {}, lock: null })
  check(w1 && w1.ok === true, 'writeSettings 经 adapterFs 成功', w1, '<ok>')
  check(w2 && w2.ok === true, 'writeState 经 adapterFs 成功', w2, '<ok>')
  check(fs._count('writeJson', 'miyoushe/settings.json') === 1, 'adapterFs.writeJson 被调用（非裸 fs）', fs._count('writeJson', 'miyoushe/settings.json'), 1)
  const reread = await core.store.readSettings()
  check(reread.tickMs === 30000, '回读生效（直读盘，cache:false）', reread.tickMs, 30000)

  // 日志：只追加（adapterFs 无 append ⇒ 读改写，尾部追加）
  await core.store.appendLog({ event: 'version.fetch', fromVersion: null, toVersion: '2.109.0', fetchHttpStatus: 200, message: 'cookie=SHOULD-BE-REDACTED' })
  await core.store.appendLog({ event: 'version.change', fromVersion: '2.71.1', toVersion: '2.109.0', downgrade: 'none', errorCode: null })
  const logRel = 'miyoushe/logs/' + localDate() + '.ndjson'
  const text = fs.files.get(MIYOUSHE_DIR + '/logs/' + localDate() + '.ndjson')
  check(typeof text === 'string' && text.split('\n').filter(Boolean).length === 2, '日志两行（只追加，未覆盖第一行）', text && text.split('\n').filter(Boolean).length, 2)
  check(!text.includes('SHOULD-BE-REDACTED'), '日志写入前过 mask（§4.2 规则 3）', text, '<无凭据串>')
  check(text.includes('<redacted>'), '日志中凭据被替换为 <redacted>', text, '<含 <redacted>>')
  check(text.split('\n').filter(Boolean).every((l) => { try { JSON.parse(l); return true } catch (e) { return false } }), '每行都是合法 JSON（无损，无 undefined）', logRel, '<ndjson>')
  check(text.split('\n').filter(Boolean).every((l) => !/undefined|NaN|\[object /.test(l)), '日志行无 undefined/NaN/[object]', text, '<无>')
  check(fs._count('writeText', logRel) === 2, '日志写经 adapterFs.writeText', fs._count('writeText', logRel), 2)

  // 盐表（§3.5.4 版本为键）：只出指纹
  const salts = {
    version: 2,
    updatedAt: '2026-09-20T01:45:32Z',
    active: { appVersion: '2.109.0', clientType: '5' },
    entries: { '2.109.0': { clientType: '5', salt: TEST_SALT, status: 'unverified-current', sourceKind: 'auto', fetchedAt: '2026-09-20T01:45:32Z' } },
    versionCache: { appVersion: '2.109.0', clientType: '5', fetchedAt: '2026-09-20T01:45:32Z', ttlMs: 86400000, lastFetchOk: true },
  }
  fs.files.set(MIYOUSHE_DIR + '/salts.json', JSON.stringify(salts, null, 2))
  const st2 = await core.status()
  console.log('status(salts) raw=' + JSON.stringify(st2))
  const wantFp = createHash('sha256').update(TEST_SALT, 'utf8').digest('hex').slice(0, 8)
  check(st2.salts.active === '2.109.0' && st2.salts.appVersion === '2.109.0', 'salts.active/appVersion 取自 entries 键（版本为键）', { a: st2.salts.active, v: st2.salts.appVersion }, '<2.109.0>')
  check(st2.salts.saltFingerprint === wantFp, 'saltFingerprint = SHA-256 前 8 位（§3.5.7）', st2.salts.saltFingerprint, wantFp)
  check(st2.salts.entryCount === 1 && st2.salts.status === 'unverified-current', 'entryCount/status 正确', { n: st2.salts.entryCount, s: st2.salts.status }, { n: 1, s: 'unverified-current' })
  check(!JSON.stringify(st2).includes(TEST_SALT), 'status 出口**不含盐明文**（只出指纹）', '(含盐)', '(不含盐)')
  check(saltFingerprint(TEST_SALT) === wantFp, '导出的 saltFingerprint 与独立计算一致', saltFingerprint(TEST_SALT), wantFp)

  // 凭据文件存在 ⇒ 只报 configured
  fs.files.set(MIYOUSHE_DIR + '/credentials.json', JSON.stringify({ accounts: [{ accountId: '123456789', cookieRaw: 'SYNTHETIC-NOT-A-REAL-CREDENTIAL' }] }))
  const st3 = await core.status()
  console.log('status(credentials) raw=' + JSON.stringify(st3))
  check(st3.credentials.configured === true, 'credentials.configured=true（存在性）', st3.credentials.configured, true)
  check(!JSON.stringify(st3).includes('SYNTHETIC-NOT-A-REAL-CREDENTIAL'), 'status 出口不含凭据值', '(含)', '(不含)')
  check(fs._count('readJson', 'miyoushe/credentials.json') === 0, '凭据内容始终未被读取', fs._count('readJson', 'miyoushe/credentials.json'), 0)
}

console.log('== (5) 损坏 JSON ⇒ 显式 BAD_ARG（不静默回落默认值吞掉损坏）==')
{
  const fs = withDir()
  fs.files.set(MIYOUSHE_DIR + '/state.json', '{ this is not json')
  const core = createCore({ adapterFs: fs })
  const st = await core.status()
  console.log('status raw=' + JSON.stringify(st))
  check(st.ok === false && st.error && st.error.code === 'BAD_ARG', 'error.code=BAD_ARG（EBADJSON 映射）', st.error && st.error.code, 'BAD_ARG')
  check(st.error && st.error.detail === 'EBADJSON', 'detail=EBADJSON', st.error && st.error.detail, 'EBADJSON')
}

console.log('== (8) t24 双不变式：**落盘保留原值** 且 **出口/日志仍脱敏** ==')
{
  const fs = withDir()
  const core = createCore({ adapterFs: fs, version: '0.1.0' })
  // 32 位 hex 盐**运行时生成**（不在源码里落 32hex 字面量 ⇒ 不破坏 assert-source-discipline 的 D3/D4）
  const SALT32 = createHash('sha256').update('t24-store-mask-fix-fixture').digest('hex').slice(0, 32)
  const SALT_FP = saltFingerprint(SALT32)
  check(/^[0-9a-f]{32}$/.test(SALT32) && SALT32 !== '<redacted>', '夹具健全性：32 位 hex 测试盐（运行时生成）', SALT32.length, 32)

  const saltsObj = {
    version: 2,
    updatedAt: '2026-09-20T03:30:00Z',
    active: { appVersion: '2.109.0', clientType: '5' },
    entries: { '2.109.0': { clientType: '5', salt: SALT32, saltFingerprint: SALT_FP, status: 'unverified-current', sourceKind: 'auto', fetchedAt: '2026-09-20T03:30:00Z' } },
    versionCache: { appVersion: '2.109.0', clientType: '5', fetchedAt: '2026-09-20T03:30:00Z', ttlMs: 86400000, lastFetchOk: true },
  }
  const w = await core.store.writeSalts(saltsObj)
  check(w && w.ok === true, 'writeSalts 经 adapterFs 成功', w, '<ok>')

  // R2① 落盘保留原值
  const back = await core.store.readSalts()
  const backSalt = back.entries['2.109.0'].salt
  check(backSalt === SALT32, 'R2① 回读 salt **逐字符等于原值**（不是 <redacted>）', backSalt === SALT32 ? 'equal' : { got: String(backSalt).slice(0, 12), len: String(backSalt).length }, 'equal')
  check(/^[0-9a-fA-F]{32}$/.test(backSalt), 'R2① 回读 salt 是 32 位 hex（签名材料未丢）', /^[0-9a-fA-F]{32}$/.test(backSalt), true)
  const diskText = fs.files.get(MIYOUSHE_DIR + '/salts.json')
  check(typeof diskText === 'string' && diskText.includes(SALT32), 'R2① 磁盘原文含盐原值', diskText && diskText.includes(SALT32), true)
  check(diskText !== undefined && !diskText.includes('<redacted>'), 'R2① 磁盘原文**不含** <redacted> 占位（落盘不再脱敏）', diskText && diskText.includes('<redacted>'), false)
  check(back.entries['2.109.0'].saltFingerprint === SALT_FP, 'R2① saltFingerprint 与取回值一致（未被落盘破坏）', back.entries['2.109.0'].saltFingerprint, SALT_FP)

  // R2② 同一对象经**出口**仍打码（两不变式同时成立）
  const out = exitPayload({ ok: true, entries: { '2.109.0': { salt: SALT32, saltFingerprint: SALT_FP } } }, 'miyoushe_version')
  check(!JSON.stringify(out).includes(SALT32), 'R2② 出口**不含**盐明文', '(含)', '(不含)')
  check(out.entries['2.109.0'].salt === '<redacted>', 'R2② 出口 salt = <redacted>（掩码兜底姿态）', out.entries['2.109.0'].salt, '<redacted>')
  const stSalts = await core.status()
  check(!JSON.stringify(stSalts).includes(SALT32), 'R2② 工具出口（status）不含盐明文（只出指纹）', '(含)', '(不含)')
  check(stSalts.salts.saltFingerprint === SALT_FP, 'R2② status 出的是指纹而非盐值', stSalts.salts.saltFingerprint, SALT_FP)

  // R3 日志脱敏**未回退**：cookie/token/salt 字段值不得落进日志
  await core.store.appendLog({ event: 't24.selftest', cookie: 'SYNTHETIC-COOKIE-t24', token: 'SYNTHETIC-TOKEN-t24', salt: SALT32, note: 'ok' })
  const logText = fs.files.get(MIYOUSHE_DIR + '/logs/' + localDate() + '.ndjson')
  check(typeof logText === 'string' && !logText.includes('SYNTHETIC-COOKIE-t24'), 'R3 日志不含 cookie 明文值', logText && logText.includes('SYNTHETIC-COOKIE-t24'), false)
  check(logText !== undefined && !logText.includes('SYNTHETIC-TOKEN-t24'), 'R3 日志不含 token 明文值', logText && logText.includes('SYNTHETIC-TOKEN-t24'), false)
  check(logText !== undefined && !logText.includes(SALT32), 'R3 日志不含 salt 明文值（写前 mask 未回退）', logText && logText.includes(SALT32), false)
  check(logText !== undefined && logText.includes('<redacted>'), 'R3 日志以 <redacted> 占位（键名保留、值打码）', logText && logText.includes('<redacted>'), true)
  check(logText !== undefined && /"cookie"/.test(logText) && /"salt"/.test(logText), 'R3 键名保留（只允许键名或占位）', '(见日志)', '<含键名>')
  check(logText !== undefined && logText.split('\n').filter(Boolean).every((l) => { try { JSON.parse(l); return true } catch (e) { return false } }), 'R3 日志仍是合法 ndjson（无损）', '(ndjson)', '<ok>')
}

console.log('')
console.log('STORE_DEGRADED failures=' + failures)
process.exitCode = failures === 0 ? 0 : 1
