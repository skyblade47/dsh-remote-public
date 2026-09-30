// @local/miyoushe —— 数据面（设计 §4.1 存储结构 + §10.1 一律走 adapterFs）
//
// 纪律（硬）：
//  1) 读写**一律**经 `adapterFs`（§10.1）；本文件**不 import 任何 fs 模块**、不自拼 `DATA_ROOT+'/'+rel`。
//  2) `adapterFs` 是**可选依赖**（§10.1）：`ctx.get('adapterFs')` 拿不到 ⇒ **显式** `NOT_READY` 降级，
//     **不静默**吞掉（本切片的降级发生在 createStore/调用时，不在模块加载时）。
//  3) `全局数据/miyoushe/` 不存在 ⇒ 显式 `FS_PARENT_MISSING`（§4.1 G6 / §6.1），
//     **绝不**自动建目录、**绝不**用裸 fs.mkdir 绕沙箱。
//  4) 盐表结构以 §3.5.4「**版本为键**」为权威（`entries[<appVersion>]`），本切片只**读骨架**、
//     不写死形状（未来 §3.5 的取回/覆盖逻辑可直接在此之上扩展）。
//  5) 凭据文件：**存在性路径不读内容**（`readCredentialsPresence()`，§4.2 规则 2：状态面只给"已配置/未配置"）；
//     **另有且仅有一条显式只读路径** `readCredentials()`（t31/S1），只供**出站请求头构造**的凭据 provider 使用；
//     其返回值**绝不允许**进入任何出口（`exitPayload`）、日志或 status；凭据类出口仍 `strict:true` fail-closed。
//  6) **落盘保留原值**（t24 修复，§4.2 的脱敏口径＝"存储保留原值，只有**出口与日志**脱敏"）：
//     JSON 写盘**不脱敏**；脱敏职责仅在 `exitPayload`（出口，默认掩码兜底）与 `appendLog`（日志，写前 `maskValue`）。
//     反面教训：写盘误套 `maskValue` ⇒ `salt` 被写成 `<redacted>` 占位、**签名材料被销毁** ⇒ 试签/自动签到必然失败。

import { maskValue, uidTail, accountKey, saltFingerprint } from './mask.js'
import { toLossless, assertLossless } from './lossless.js'

export const ROOT_NAME = '全局数据'
export const PLUGIN_SUBDIR = 'miyoushe'

/** §4.1 文件结构（根＝`全局数据`，即 `E:/DSH工作区/全局数据/miyoushe/`） */
export const REL = Object.freeze({
  settings: 'miyoushe/settings.json',
  salts: 'miyoushe/salts.json',
  state: 'miyoushe/state.json',
  credentials: 'miyoushe/credentials.json',
  accounts: 'miyoushe/accounts.json',
  endpoints: 'miyoushe/endpoints.json',
  logsDir: 'miyoushe/logs',
})

// 2026-09-22 Linux 化：原为 'E:/DSH工作区/' + ...，写死盘符 ⇒ Linux 上会把用户指向不存在的路径。
// 改为**根相对写法**（与 gate.js 的 `全局数据/miyoushe/` 同口径）：绝对位置由 adapter 根表决定，
// Windows 默认 E:/DSH工作区、Linux 由 DSH_WORKSPACE_ROOT 注入。
export const DATA_DIR_HINT = ROOT_NAME + '/' + PLUGIN_SUBDIR + '/'

/** §5.1 默认值（settings.json 缺文件时使用；值可被用户改） */
export const SETTINGS_DEFAULTS = Object.freeze({
  version: 1,
  tickMs: 60000,
  windowStart: '08:00',
  windowEnd: '23:30',
  dailyJitterMs: 900000,
  accountGapMs: [5000, 25000],
  maxAttemptsPerDay: 3,
  backoffMs: [300000, 1200000, 3600000],
  bbsEnabled: true,
  autoFetchVersion: true,
  allowLateSign: false,
  schedule: { enabled: false },
})

/** §5.2/§6.4 state.json 骨架（`schedule.enabled` + `lastSignSuccess` 是门禁判据来源） */
export const STATE_DEFAULTS = Object.freeze({
  version: 1,
  schedule: { enabled: false, mode: 'readonly', nextAt: null, lastRunAt: null, pausedBy: null },
  doneKeys: {},
  lastSignSuccess: {},
  lock: null,
})

/** §3.5.4 盐表骨架（**版本为键**；空骨架，不写死任何真实盐） */
export const SALTS_DEFAULTS = Object.freeze({
  version: 2,
  updatedAt: null,
  active: null,
  entries: {},
  versionCache: null,
})

export class StoreError extends Error {
  constructor(code, message, detail) {
    super(message)
    this.name = 'StoreError'
    this.code = code
    this.detail = detail === undefined || detail === null ? null : String(detail)
  }
}

/** 本地日期 `yyyy-mm-dd`（§5.2 去重键 / §5.4 日志字段） */
export function localDate(d) {
  const x = d instanceof Date ? d : new Date(d === undefined ? Date.now() : d)
  const p = (n) => String(n).padStart(2, '0')
  return x.getFullYear() + '-' + p(x.getMonth() + 1) + '-' + p(x.getDate())
}

/** 本地时区偏移（§3.5.7 日志另记 `tz`） */
export function tzOffset(d) {
  const x = d instanceof Date ? d : new Date(d === undefined ? Date.now() : d)
  const m = -x.getTimezoneOffset()
  const sign = m >= 0 ? '+' : '-'
  const a = Math.abs(m)
  return sign + String(Math.floor(a / 60)).padStart(2, '0') + ':' + String(a % 60).padStart(2, '0')
}

function isAdapterFs(adapterFs) {
  if (!adapterFs || typeof adapterFs !== 'object') return false
  for (const m of ['readJson', 'writeJson', 'readText', 'writeText', 'exists', 'resolve']) {
    if (typeof adapterFs[m] !== 'function') return false
  }
  return true
}

/**
 * createStore({ adapterFs }) —— 数据面。adapterFs 缺失即为 `NOT_READY` 降级（显式，不静默）。
 * 本函数**不碰盘**、**不建目录**；只有调用 read / write / assertDataDir 系列时才经 adapterFs 访问。
 */
export function createStore(deps) {
  const adapterFs = deps && deps.adapterFs ? deps.adapterFs : undefined
  const hasDataFace = isAdapterFs(adapterFs)

  function notReady(detail) {
    return new StoreError(
      'NOT_READY',
      '数据面未就绪：adapterFs 服务缺失（未接线 / @local/dsh-adapter 未加载）',
      detail === undefined ? "ctx.get('adapterFs') 返回 undefined 或不满足契约（需 readJson/writeJson/readText/writeText/exists/resolve）" : detail,
    )
  }

  function mapAdapterError(e, action) {
    const code = e && e.code ? String(e.code) : null
    if (code === 'ADAPTER_UNAVAILABLE') return notReady('adapterFs 底座 ctx.fs 缺失')
    if (code === 'ROOT_UNKNOWN') {
      // 登记根缺失（adapter 配置未声明 `全局数据`）与"目录不存在"在可用性上等价
      return new StoreError('FS_PARENT_MISSING', '数据目录不可用：adapter 根 `' + ROOT_NAME + '` 未登记（ROOT_UNKNOWN）', 'ROOT_UNKNOWN:' + ROOT_NAME)
    }
    if (code === 'EBADJSON') {
      return new StoreError('BAD_ARG', '数据文件损坏（JSON 解析失败）：' + (action || '') + '；请修复或备份后重建（插件不自动重建，避免静默丢数据）', 'EBADJSON')
    }
    return new StoreError('FS_IO_ERROR', (action ? action + '：' : '') + (e && e.message ? e.message : String(e)), code)
  }

  /** 探测数据目录（不抛，返回结论）；用于 status/diagnostics */
  async function probeDataDir() {
    if (!hasDataFace) throw notReady()
    let exists
    try {
      exists = await adapterFs.exists(ROOT_NAME, PLUGIN_SUBDIR)
    } catch (e) {
      const mapped = mapAdapterError(e, '探测数据目录失败')
      if (mapped.code === 'FS_PARENT_MISSING') return { ok: false, exists: false, code: mapped.code, detail: mapped.detail }
      throw mapped
    }
    return { ok: !!exists, exists: !!exists, code: exists ? null : 'FS_PARENT_MISSING', detail: exists ? null : 'FS_NOT_FOUND:' + PLUGIN_SUBDIR }
  }

  /** 断言数据目录可用（NOT_READY / FS_PARENT_MISSING 显式抛）；**不创建目录** */
  async function assertDataDir() {
    if (!hasDataFace) throw notReady()
    const p = await probeDataDir()
    if (!p.ok) {
      let display = DATA_DIR_HINT
      try {
        const t = await adapterFs.resolve(ROOT_NAME, PLUGIN_SUBDIR)
        if (t && (t.displayPath || t.targetKey)) display = String(t.displayPath || t.targetKey)
      } catch (e) { /* 取显示路径失败不影响判定，回落常量提示 */ }
      throw new StoreError(
        'FS_PARENT_MISSING',
        '数据目录不存在，请先创建：`' + display + '`（插件不自动建目录，§4.1 G6）',
        p.detail,
      )
    }
    return { ok: true, displayPath: DATA_DIR_HINT }
  }

  async function readJsonExplicit(rel, fallbackValue) {
    await assertDataDir()
    try {
      return await adapterFs.readJson(ROOT_NAME, rel) // cache:false 直读（§4.1 写盘纪律）
    } catch (e) {
      if (e && e.code === 'FS_NOT_FOUND') return fallbackValue
      throw mapAdapterError(e, '读取 ' + rel + ' 失败')
    }
  }

  /**
   * JSON **落盘**：**保留原值**（§4.2 脱敏口径＝「存储保留原值，只有**出口与日志**脱敏」）。
   * t24 修复：此处曾误套 `maskValue` ⇒ `salt` 等 `SECRET_KEYS` 字段被写成 `<redacted>` 占位，
   * 真实取回的**盐值被销毁**（DS 签名材料丢失 ⇒ 试签/自动签到必然失败）。
   * 现在只做无损化（`toLossless`），**不做**脱敏；脱敏职责在 `exitPayload`（出口）与 `appendLog`（日志）。
   */
  async function writeJsonSafe(rel, data) {
    await assertDataDir()
    try {
      return await adapterFs.writeJson(ROOT_NAME, rel, toLossless(data))
    } catch (e) {
      throw mapAdapterError(e, '写入 ' + rel + ' 失败')
    }
  }

  return {
    hasDataFace: () => hasDataFace,
    relPaths: () => REL,
    describe() {
      return { hasDataFace, root: ROOT_NAME, subdir: PLUGIN_SUBDIR, dataDirHint: DATA_DIR_HINT }
    },
    probeDataDir,
    assertDataDir,
    async readSettings() { return readJsonExplicit(REL.settings, clone(SETTINGS_DEFAULTS)) },
    async readState() { return readJsonExplicit(REL.state, clone(STATE_DEFAULTS)) },
    async readSalts() { return readJsonExplicit(REL.salts, clone(SALTS_DEFAULTS)) },
    async readAccounts() { return readJsonExplicit(REL.accounts, { version: 1, updatedAt: null, accounts: [] }) },
    async readEndpoints() { return readJsonExplicit(REL.endpoints, { version: 1, updatedAt: null, endpoints: {} }) },
    writeSettings(data) { return writeJsonSafe(REL.settings, data) },
    writeState(data) { return writeJsonSafe(REL.state, data) },
    writeSalts(data) { return writeJsonSafe(REL.salts, data) },
    /**
     * t52/Q1：凭据**写入**（D-3 未尽项）。与其它 `writeXxx` 同走 `writeJsonSafe`（**保留原值**，
     * 因为签名需要凭据原文；脱敏职责在出口与日志 —— 见 §4.2 与 `writeJsonSafe` 的注释）。
     * 形状由调用方给定（沿用 t31 定形结构），本方法不当"结构警察"。
     */
    writeCredentials(data) { return writeJsonSafe(REL.credentials, data) },
    /**
     * t52/Q1：凭据**清除**。`adapterFs` 契约（`exists/readText/readJson/writeText/writeJson/listDir/resolve`）
     * **没有删除 API** ⇒ 无法保证真正 unlink：**先尝试**可选删除方法（不同适配器可能有），
     * **否则**写成空骨架（`accounts: []`）。两种情况都返回 `configured:false`，
     * 并如实回 `removed`（是否真的删掉了文件）——**不谎报**。
     * 注意：本方法**不**改变 `readCredentialsPresence()` 的"纯存在性、不读内容"纪律（该纪律有独立断言保护）；
     *   "已清除"的**可观测性**由 state 侧的显式否定（`{configured:false, clearedAt}`）承担（见 index.js）。
     */
    async clearCredentials() {
      const del = typeof adapterFs.remove === 'function' ? adapterFs.remove
        : (typeof adapterFs.delete === 'function' ? adapterFs.delete
          : (typeof adapterFs.unlink === 'function' ? adapterFs.unlink
            : (typeof adapterFs.removeFile === 'function' ? adapterFs.removeFile : null)))
      let removed = false
      if (del) {
        try { await del.call(adapterFs, ROOT_NAME, REL.credentials); removed = true } catch (e) { removed = false }
      }
      if (!removed) {
        const emptied = { version: 1, updatedAt: new Date().toISOString(), accounts: [] }
        await writeJsonSafe(REL.credentials, emptied)
      }
      return { configured: false, removed, emptied: !removed, path: REL.credentials }
    },
    /** 凭据**只探存在性**（§4.2 规则 2）：不读内容、不入内存、不入出口（t52 未改动本纪律） */
    async readCredentialsPresence() {
      await assertDataDir()
      try {
        const present = await adapterFs.exists(ROOT_NAME, REL.credentials)
        return { configured: !!present, path: REL.credentials }
      } catch (e) {
        throw mapAdapterError(e, '探测凭据文件失败')
      }
    },
    /**
     * 凭据**读取**（t31/S1；只读、只进不出）。
     * 与 `readCredentialsPresence()` 的分工：存在性探测不读内容，`status`/日志/出口一律走它；
     * 本方法**只供**出站请求头构造的凭据 provider 使用，返回值**永不**进入出口/日志。
     * 文件格式（t31 定形，与读取实现一致）：
     *   { "version": 1, "updatedAt": "<ISO>",
     *     "accounts": [ { "accountKey": "acct-***1234", "credential": "<凭据原文（HTTP 头值）>",
     *                     "uid": "<原值>", "createdAt": "<ISO>", "lastOkAt": null } ] }
     * 文件缺失/空 ⇒ `null`；结构不符 ⇒ 只保留合法条目（不静默编造）。
     */
    async readCredentials() {
      await assertDataDir()
      let raw = null
      try {
        raw = await adapterFs.readJson(ROOT_NAME, REL.credentials)
      } catch (e) {
        if (e && e.code === 'FS_NOT_FOUND') return null
        throw mapAdapterError(e, '读取凭据失败')
      }
      return normalizeCredentialFile(raw)
    },
    async logsDirPresent() {
      await assertDataDir()
      try { return !!(await adapterFs.exists(ROOT_NAME, REL.logsDir)) } catch (e) { throw mapAdapterError(e, '探测日志目录失败') }
    },
    async listLogs() {
      await assertDataDir()
      try { return await adapterFs.listDir(ROOT_NAME, REL.logsDir) } catch (e) { throw mapAdapterError(e, '列举日志失败') }
    },
    /**
     * 追加一条日志事件（§4.1 logs/YYYY-MM-DD.ndjson，只追加；§4.2 规则 3 写前 mask）。
     * 注意：`adapterFs` **没有** append 原语 ⇒ 采用"读改写、只在尾部追加"（并发由 §5.5 单飞锁保证）。
     */
    async appendLog(event) {
      await assertDataDir()
      const nowIso = new Date().toISOString()
      const rec = toLossless(maskValue(Object.assign({ ts: nowIso, tz: tzOffset(), date: localDate() }, event)))
      assertLossless(rec, 'log-record')
      const rel = REL.logsDir + '/' + rec.date + '.ndjson'
      let prev = ''
      try {
        if (await adapterFs.exists(ROOT_NAME, rel)) prev = await adapterFs.readText(ROOT_NAME, rel)
      } catch (e) {
        throw mapAdapterError(e, '读取既有日志失败')
      }
      const line = JSON.stringify(rec) + '\n'
      try {
        const res = await adapterFs.writeText(ROOT_NAME, rel, prev + line)
        return { rel, appendedBytes: line.length, operation: res && res.operation ? res.operation : null }
      } catch (e) {
        const mapped = mapAdapterError(e, '写日志失败（logs 目录是否已创建：' + REL.logsDir + '）')
        throw mapped
      }
    },
    // 供上层做脱敏/指纹（避免各文件各自 import）
    uidTail,
    accountKey,
    saltFingerprint,
  }
}

function clone(v) {
  return JSON.parse(JSON.stringify(v))
}

/**
 * 凭据文件结构归一化（t31/S1 定形；**纯函数**）。
 * 只保留含非空 `credential` 的条目；`primary` ＝ 第一条（单账号场景即它）。
 * 注意：返回对象**含凭据原值** ⇒ 只允许交给凭据 provider，**不得**进入出口/日志（见本文件头注纪律 5）。
 */
function normalizeCredentialFile(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null
  if (src === null) return null
  const list = Array.isArray(src.accounts) ? src.accounts : []
  const accounts = []
  for (const item of list) {
    const a = item && typeof item === 'object' && !Array.isArray(item) ? item : {}
    if (typeof a.credential !== 'string' || a.credential.length === 0) continue
    accounts.push({
      accountKey: typeof a.accountKey === 'string' && a.accountKey ? a.accountKey : null,
      credential: a.credential,
      uid: a.uid === undefined || a.uid === null ? null : String(a.uid),
      createdAt: a.createdAt === undefined ? null : a.createdAt,
      lastOkAt: a.lastOkAt === undefined ? null : a.lastOkAt,
    })
  }
  return {
    version: Number.isFinite(src.version) ? src.version : 1,
    updatedAt: src.updatedAt === undefined ? null : src.updatedAt,
    accounts,
    primary: accounts.length > 0 ? accounts[0] : null,
  }
}
