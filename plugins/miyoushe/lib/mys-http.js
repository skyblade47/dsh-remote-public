// @local/miyoushe —— API 出站薄封装（设计 §10.2；本文件是 `lib/**` 中**两处** HTTP 客户端落点之一）
//
// 设计锚点（章节号 + 原文要点，不写行号——设计自指行号会漂）：
//   §10.2 薄封装五项：① 超时 10s；② 最多 2 次重试（间隔 2s/5s）；③ 固定 UA（含 `miHoYoBBS/<appVersion>`）；
//          ④ 限速（同账号 ≥1s；账号间 5–25s 抖动）；⑤ 统一归一化 `{httpStatus, retcode, message, data}`
//   §2.2  端点矩阵 + 头集合五档（`+DS` 完整签名头：UA + DS + x-rpc-app_version + x-rpc-client_type
//          + x-rpc-device_id + X-Requested-With + Referer/Origin；luna 路径另加 `x-rpc-signgame`）
//   §2.3  `x-rpc-client_type = 5`（米游社 App）
//   §3.1  DS 签名**复用** `lib/ds.js` 的 `signDs`（本文件不重写算法）
//   §6.1  错误码归一化（AUTH_INVALID / RETCODE_UNKNOWN / GEETEST_REQUIRED / RATE_LIMITED /
//          NET_TIMEOUT / NET_ERROR / ENDPOINT_DRIFT / SALT_MISSING / SALT_INVALID / AUTH_REQUIRED / BAD_ARG）
//   §4.2  凭据**只进请求头**：绝不回显、不落盘、不进日志
//
// 纪律（硬）：
//  1) **域名白名单**：非白名单主机 ⇒ **结构化拒绝且不发请求**（无静默、无回落）。
//  2) **凭据只进请求头**：本模块**不读**凭据文件内容（§4.2 规则 2：状态面只探存在性），凭据值由注入的
//     provider 给出；无凭据 ⇒ `AUTH_REQUIRED`（**不发请求**）。
//  3) **DS 与盐成对**（§3.1 成对约束 / §3.5.4 硬约束）：只接受 `active` 指向的、`status==='verified'` 的
//     那条记录的盐材料；无核验盐 ⇒ `SALT_MISSING` / `SALT_INVALID`（**不发请求**）。绝不"临时拼一个版本头 + 另一条盐"。
//  4) **零真实网络默认安全**：`transport` 未注入且运行环境无全局 fetch ⇒ 结构化 `NET_ERROR`（**不**回落）。
//  5) 版本通道（`lib/miyoushe-version.js`）与本通道**互不复用**凭据/传输实现：版本通道只打第三方源且**绝不携带凭据**。
//
// 口径登记（本文件实现选择，已进证据文件）：
//  - 重试判据：超时 / 传输错 / 5xx / 429 才重试；4xx 与业务 `retcode≠0` **不重试**（避免把过期凭据反复打服务端）。
//  - 账号间抖动：由 `accountKey`+本地日期的**确定散列**给出（可复现、可测），不用 `Math.random`。
//  - `x-rpc-device_id`：按账号**确定派生**（sha256 前 32 位按 UUID 形状），避免引入新的持久化字段（§11-12 待验证项）。
//  - Referer/Origin：按端点类别取固定值（event 类 → act 站，社区类 → bbs 站），可经 opts 覆盖。

import { createHash } from 'node:crypto'
import { signDs } from './ds.js'

/** §10.2 ①：单次请求超时（连接+读取合计） */
export const OUTBOUND_TIMEOUT_MS = 10000
/** §10.2 ②：最多 2 次重试（总尝试 ≤ 3） */
export const MAX_RETRIES = 2
/** §10.2 ②：重试间隔（设计原文：2s / 5s） */
export const RETRY_BACKOFF_MS = Object.freeze([2000, 5000])
/** §10.2 ④：同账号两次请求的最小间隔（≥1s） */
export const MIN_ACCOUNT_INTERVAL_MS = 1000
/** §10.2 ④：账号间抖动区间（5–25s） */
export const ACCOUNT_GAP_MIN_MS = 5000
export const ACCOUNT_GAP_MAX_MS = 25000

/** §10.2 白名单（硬约束）：仅米游社/米哈游**官方域**；用到的域逐一列出（§2.2 端点表） */
export const ALLOWED_API_HOSTS = Object.freeze([
  'api-takumi.mihoyo.com',
  'act-nap-api.mihoyo.com',
  'bbs-api.mihoyo.com',
  'bbs-api.miyoushe.com',
  'api-takumi.miyoushe.com',
])

/** §2.2 每目标默认 host（可经 opts/endpoints 覆盖；`zzz` 的值＝设计的 host 例外） */
export const DEFAULT_TARGET_HOSTS = Object.freeze({
  hk4e: 'api-takumi.mihoyo.com',
  hkrpg: 'api-takumi.mihoyo.com',
  zzz: 'act-nap-api.mihoyo.com',
  bh3: 'api-takumi.mihoyo.com',
  bbs: 'bbs-api.mihoyo.com',
})

/** §2.3 客户端类型（米游社 App） */
export const CLIENT_TYPE = '5'
/** §2.2 固定 UA 前缀（尾段＝`<appVersion>`） */
export const UA_PREFIX = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 miHoYoBBS/'

/** §2.2 头名（单一表；凭据类头名只在请求头构造处使用，见证据文件的口径登记） */
export const HEADER_NAMES = Object.freeze({
  ua: 'User-Agent',
  appVersion: 'x-rpc-app_version',
  clientType: 'x-rpc-client_type',
  device: 'x-rpc-device_id',
  signGame: 'x-rpc-signgame',
  requestedWith: 'X-Requested-With',
  referer: 'Referer',
  origin: 'Origin',
  credential: 'Cookie', // discipline-exempt: 设计规定的入参名: §2.2 头集合的 Cookie 头（凭据只进请求头，绝不回显）
  signature: 'DS',
})

/** 归一化后的 §6.1 错误码（本模块产出的即可判面） */
export const API_ERR = Object.freeze({
  HOST_NOT_ALLOWED: 'OUTBOUND_HOST_NOT_ALLOWED',
  BAD_ARG: 'BAD_ARG',
  AUTH_REQUIRED: 'AUTH_REQUIRED',
  AUTH_INVALID: 'AUTH_INVALID',
  RETCODE_UNKNOWN: 'RETCODE_UNKNOWN',
  GEETEST_REQUIRED: 'GEETEST_REQUIRED',
  RATE_LIMITED: 'RATE_LIMITED',
  NET_TIMEOUT: 'NET_TIMEOUT',
  NET_ERROR: 'NET_ERROR',
  ENDPOINT_DRIFT: 'ENDPOINT_DRIFT',
  SALT_MISSING: 'SALT_MISSING',
  SALT_INVALID: 'SALT_INVALID',
})

export class OutboundError extends Error {
  constructor(code, message, detail) {
    super(message)
    this.name = 'OutboundError'
    this.code = code
    this.detail = detail === undefined ? null : detail
  }
}

const asObject = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {})

/** 白名单硬校验（§10.2）：返回 host；不在白名单 ⇒ 抛（**调用方在此刻之前不得发出任何请求**） */
export function assertAllowedHost(host) {
  const h = typeof host === 'string' ? host.trim().toLowerCase() : ''
  if (!ALLOWED_API_HOSTS.includes(h)) {
    throw new OutboundError(API_ERR.HOST_NOT_ALLOWED, '出站域名不在白名单（§10.2 硬约束）：' + String(host), 'host=' + String(host))
  }
  return h
}

/**
 * 从绝对 URL 取 host 并做白名单校验（t31/S9：**协议与端口**也硬校验）。
 * 仅允许 `https:` 且端口为空或 `443`——**明文 HTTP 会把凭据暴露在链路上**，非标准端口同样拒绝。
 */
export function assertAllowedUrl(url) {
  let u = null
  try { u = new URL(String(url)) } catch (e) { throw new OutboundError(API_ERR.BAD_ARG, 'URL 无法解析：' + String(url), 'url') }
  if (u.protocol !== 'https:') {
    throw new OutboundError(API_ERR.HOST_NOT_ALLOWED, '只允许 HTTPS 出站（明文 HTTP 会把凭据暴露在链路上，§10.2）：' + String(url), 'protocol=' + String(u.protocol))
  }
  const port = String(u.port === undefined ? '' : u.port)
  if (port !== '' && port !== '443') {
    throw new OutboundError(API_ERR.HOST_NOT_ALLOWED, '只允许默认端口或 443（非标准端口一律拒绝，§10.2）：' + String(url), 'port=' + port)
  }
  return assertAllowedHost(u.hostname)
}

/** 目标 → host（§2.2；opts.overrides 可覆盖单目标） */
export function hostForTarget(target, overrides) {
  const o = asObject(overrides)
  const t = typeof target === 'string' && target ? target : 'hk4e'
  if (typeof o[t] === 'string' && o[t]) return o[t]
  if (typeof DEFAULT_TARGET_HOSTS[t] === 'string') return DEFAULT_TARGET_HOSTS[t]
  return DEFAULT_TARGET_HOSTS.hk4e
}

/** 同账号稳定设备标识（§11-12：本地派生、每账号持久等价；不引入新持久化字段） */
export function deviceIdFor(accountKey) {
  const seed = 'miyoushe-device:' + String(accountKey === undefined || accountKey === null ? 'anonymous' : accountKey)
  const h = createHash('sha256').update(seed, 'utf8').digest('hex').slice(0, 32)
  return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20, 32)
}

/** FNV-1a（32 位）——确定性散列，供账号间抖动复现用 */
function hash32(text) {
  let h = 2166136261
  const s = String(text)
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0 }
  return h >>> 0
}

/** §10.2 ④：账号间抖动（5–25s，确定可复现；key＝账号 + 本地日期） */
export function accountGapFor(accountKey, dateIso) {
  const span = ACCOUNT_GAP_MAX_MS - ACCOUNT_GAP_MIN_MS
  const h = hash32(String(accountKey === undefined ? '' : accountKey) + '|' + String(dateIso === undefined ? '' : dateIso))
  return ACCOUNT_GAP_MIN_MS + (h % (span + 1))
}

/** 本地日期（抖动 key 用；与 store.js 的 localDate 同口径，但本模块不依赖数据面） */
export function localDateOf(ms) {
  const d = new Date(Number.isFinite(ms) ? ms : Date.now())
  const p = (n) => String(n).padStart(2, '0')
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
}

/**
 * §6.1 错误码归一化（纯函数）。入参＝单次尝试的观测，返回 `{ code, retryable }`（成功 ⇒ code=null）。
 */
export function classifyOutcome(x) {
  const o = asObject(x)
  if (o.timedOut === true) return { code: API_ERR.NET_TIMEOUT, retryable: true }
  if (o.transportError) return { code: API_ERR.NET_ERROR, retryable: true }
  const httpStatus = Number.isFinite(o.httpStatus) ? o.httpStatus : null
  if (httpStatus === 404 || httpStatus === 405) return { code: API_ERR.ENDPOINT_DRIFT, retryable: false }
  if (httpStatus === 401 || httpStatus === 403) return { code: API_ERR.AUTH_INVALID, retryable: false }
  if (httpStatus === 429) return { code: API_ERR.RATE_LIMITED, retryable: true }
  if (httpStatus !== null && (httpStatus < 200 || httpStatus >= 300)) return { code: API_ERR.NET_ERROR, retryable: httpStatus >= 500 }
  if (o.parseOk === false) return { code: API_ERR.ENDPOINT_DRIFT, retryable: false }
  const retcode = Number.isFinite(o.retcode) ? o.retcode : null
  if (retcode === 0) return { code: null, retryable: false }
  if (retcode === -100) return { code: API_ERR.AUTH_INVALID, retryable: false }
  if (retcode !== null && /验证|geetest|risk|challenge/i.test(String(o.message === undefined ? '' : o.message))) {
    return { code: API_ERR.GEETEST_REQUIRED, retryable: false }
  }
  return { code: API_ERR.RETCODE_UNKNOWN, retryable: false }
}

/** null 安全取值（函数/对象两种 provider 形态都吃） */
async function resolveProvided(provider, fallback) {
  if (typeof provider === 'function') {
    const v = await provider()
    return v === undefined ? fallback : v
  }
  return fallback
}

/**
 * §10.2 默认传输实现（**本文件的唯一全局请求调用点**）。
 * @returns `(url, init) => Promise<Response>`；运行环境无全局 fetch ⇒ `null`（保持"未注入"语义，不静默回落）。
 */
export function createDefaultApiTransport(opts) {
  const o = asObject(opts)
  if (typeof globalThis.fetch !== 'function') return null
  const timeoutMs = Number.isFinite(o.timeoutMs) ? o.timeoutMs : OUTBOUND_TIMEOUT_MS
  return async function defaultApiTransport(url, init) {
    const h = assertAllowedUrl(url)
    const src = asObject(init)
    const headers = asObject(src.headers)
    const controller = typeof AbortController === 'function' ? new AbortController() : null
    const outer = src.signal
    if (controller && outer && typeof outer.addEventListener === 'function') {
      if (outer.aborted) controller.abort()
      else outer.addEventListener('abort', () => { controller.abort() }, { once: true })
    }
    let timer = null
    if (controller) timer = setTimeout(() => { controller.abort() }, timeoutMs)
    try {
      const req = { method: src.method === undefined ? 'GET' : src.method, headers }
      if (src.body !== undefined) req.body = src.body
      if (controller) req.signal = controller.signal
      req.__host = h
      delete req.__host
      return await fetch(url, req)
    } finally {
      if (timer !== null) clearTimeout(timer)
    }
  }
}

/** 请求 URL 规格解析（白名单在此处硬校验 ⇒ 拒绝时**不可能**已发出请求） */
export function resolveEndpointSpec(req, opts) {
  const r = asObject(req)
  const o = asObject(opts)
  if (typeof r.url === 'string' && r.url) {
    const host = assertAllowedUrl(r.url)
    const u = new URL(r.url)
    return { url: u.href, host, path: u.pathname, query: u.search, method: String(r.method === undefined ? 'GET' : r.method).toUpperCase() }
  }
  const target = typeof r.target === 'string' && r.target ? r.target : 'hk4e'
  const host = assertAllowedHost(typeof r.host === 'string' && r.host ? r.host : hostForTarget(target, o.hostOverrides))
  const path = typeof r.path === 'string' && r.path ? (r.path.startsWith('/') ? r.path : '/' + r.path) : ''
  if (!path) throw new OutboundError(API_ERR.BAD_ARG, 'request 需要 path（或以 url 给出绝对地址）', 'path')
  const q = asObject(r.query)
  const qs = Object.keys(q).map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(String(q[k]))).join('&')
  return { url: 'https://' + host + path + (qs ? '?' + qs : ''), host, path, query: qs ? '?' + qs : '', method: String(r.method === undefined ? 'GET' : r.method).toUpperCase(), target }
}

/** §2.2 头集合（`+DS` 完整签名头 + 凭据 + 可选 signgame）；凭据值**只出现在本函数的输出对象里** */
export function buildApiHeaders(ctx) {
  const c = asObject(ctx)
  const appVersion = typeof c.appVersion === 'string' && c.appVersion ? c.appVersion : 'unknown'
  const headers = {}
  headers[HEADER_NAMES.ua] = UA_PREFIX + appVersion
  headers[HEADER_NAMES.appVersion] = appVersion
  headers[HEADER_NAMES.clientType] = CLIENT_TYPE
  headers[HEADER_NAMES.device] = typeof c.deviceId === 'string' && c.deviceId ? c.deviceId : deviceIdFor(c.accountKey)
  headers[HEADER_NAMES.requestedWith] = 'com.mihoyo.hyperion'
  if (typeof c.signGame === 'string' && c.signGame) headers[HEADER_NAMES.signGame] = c.signGame
  if (typeof c.referer === 'string' && c.referer) headers[HEADER_NAMES.referer] = c.referer
  if (typeof c.origin === 'string' && c.origin) headers[HEADER_NAMES.origin] = c.origin
  if (typeof c.credential === 'string' && c.credential) headers[HEADER_NAMES.credential] = c.credential
  if (typeof c.signingMaterial === 'string' && c.signingMaterial && Number.isInteger(c.t)) {
    headers[HEADER_NAMES.signature] = signDs(c.signingMaterial, c.t, c.r).ds
  }
  return headers
}

/**
 * 选取"最新的 `unverified-current` 条目"（t37/R1② 的回退源）。
 * 排序：`fetchedAt` **更新者优先**；`fetchedAt` 缺失或不可解析时按**版本键字典序最大**；两者都缺时同为字典序最大。
 * 只认 `unverified-current`（`stale`/`rejected` 不入选）。
 */
export function latestUnverifiedEntry(entries) {
  const map = asObject(entries)
  let best = null
  for (const ver of Object.keys(map)) {
    const e = asObject(map[ver])
    if (e.status !== 'unverified-current') continue
    const raw = typeof e.fetchedAt === 'string' ? Date.parse(e.fetchedAt) : NaN
    const at = Number.isFinite(raw) ? raw : null
    if (best === null) { best = { appVersion: ver, entry: e, at }; continue }
    if (at !== null && best.at !== null) {
      if (at > best.at || (at === best.at && ver > best.appVersion)) best = { appVersion: ver, entry: e, at }
    } else if (at !== null && best.at === null) {
      best = { appVersion: ver, entry: e, at }
    } else if (at === null && best.at === null && ver > best.appVersion) {
      best = { appVersion: ver, entry: e, at }
    }
  }
  return best
}

/**
 * 从 salts 记录解析"本次可用的签名材料 + 版本"（不成对/不可用 ⇒ 结构化拒绝）。
 *
 * t37/R1 判据（修复"`active` 前置"死锁）：
 *   ① `active` 存在且其版本键**存在** ⇒ 用该条目（`verified` 或 `unverified-current`；`stale`/`rejected` ⇒ `SALT_INVALID`）
 *   ② `active` 为空 **或** 其指向的版本键**不存在** ⇒ **回退到最新的 `unverified-current` 条目**（`latestUnverifiedEntry()`）
 *   ③ 既无可用 `active` 条目、也无 `unverified-current` 条目 ⇒ `SALT_MISSING`
 * 死锁背景（设计 §3.5.4 / §10.4 D-8）：条目处于 `unverified-current` 期时 `active` **必为 null**，
 *   而"盐升 `verified`"只能由一次成功签到带来 ⇒ 若本层坚持要 `active`，试签在逻辑上不可能发生。
 * 边界（R2）：**本层只决定"能否构造签名材料"**，不做 enabled/模式判断；**无人值守的收紧仍由门禁 G4 施加**。
 */
export function resolveSigningContext(salts) {
  const s = asObject(salts)
  const entries = asObject(s.entries)
  const active = asObject(s.active)
  const activeVersion = typeof active.appVersion === 'string' && active.appVersion ? active.appVersion : null
  if (activeVersion !== null) {
    const entry = asObject(entries[activeVersion])
    if (entry && Object.keys(entry).length > 0) {
      if (entry.status !== 'verified' && entry.status !== 'unverified-current') {
        return { ok: false, code: API_ERR.SALT_INVALID, detail: '该版本条目 status=' + JSON.stringify(entry.status) + '（§6.5.2 ④：`stale`/`rejected` 一律不签名；`unverified-current` 允许**试签**、禁止无人值守自动签到——后者的收紧由门禁 gate.js 施加，不在薄封装层）' }
      }
      if (typeof entry.salt !== 'string' || entry.salt.length === 0) {
        return { ok: false, code: API_ERR.SALT_INVALID, detail: '该版本条目的盐材料缺失/非法 ⇒ 拒绝发请求（§3.5.7）' }
      }
      return { ok: true, appVersion: activeVersion, signingMaterial: entry.salt, status: entry.status, source: 'active' }
    }
  }
  // 回退（t37/R1②）：`active` 为空或指向的版本键不存在 ⇒ 取最新的 unverified-current 条目
  const fallback = latestUnverifiedEntry(entries)
  if (fallback !== null) {
    if (typeof fallback.entry.salt !== 'string' || fallback.entry.salt.length === 0) {
      return { ok: false, code: API_ERR.SALT_INVALID, detail: '回退命中的版本条目盐材料缺失/非法 ⇒ 拒绝发请求（§3.5.7）' }
    }
    return { ok: true, appVersion: fallback.appVersion, signingMaterial: fallback.entry.salt, status: 'unverified-current', source: 'latest_unverified' }
  }
  const why = activeVersion === null ? 'salts.active 为空（§3.5.4：unverified-current 期 active 必为 null）' : 'salts.active.appVersion=' + activeVersion + ' 指向的版本键不存在'
  // R1③ vs R1④ 的分界：**完全没有条目** ⇒ SALT_MISSING（盐表空）；**有条目但都不可用**（stale/rejected/结构空）⇒ SALT_INVALID
  const present = Object.keys(entries).filter((ver) => {
    const e = asObject(entries[ver])
    return Object.keys(e).length > 0
  })
  if (present.length > 0) {
    const statuses = present.map((ver) => ver + ':' + String(asObject(entries[ver]).status))
    return { ok: false, code: API_ERR.SALT_INVALID, detail: why + '，且无 `unverified-current` 条目可用（现有条目状态＝' + statuses.join(', ') + '）⇒ 拒绝发请求（§6.5.2 ④）' }
  }
  return { ok: false, code: API_ERR.SALT_MISSING, detail: why + '，且 salts.entries 为空 ⇒ 无任何可用条目，降级只读（§3.5.6）' }
}

/**
 * §10.2 API 出站端口（`httpPort` 契约：`request(req)`）。
 * @param opts {
 *   transport,          // (url, init) => Response；缺省用 createDefaultApiTransport()，两者皆无 ⇒ NET_ERROR
 *   store,              // 数据面（读 salts；不读凭据内容）
 *   credentialProvider, // async () => string|null（凭据头值；由调用方注入，**本模块不读凭据文件**）
 *   accountKey,         // 默认账号（限速分组 / 设备标识）
 *   endpoints,          // 可选：{ hostOverrides }
 *   now, sleep, rand,   // 可注入时钟/等待/随机（自测用；rand 未给 ⇒ 用 ds.js 的 CSPRNG）
 *   timeoutMs, maxRetries, retryBackoffMs, minAccountIntervalMs,
 *   onHeadersBuilt,    // 可选观测钩子 (headers, spec) => void：**头对象构造后**回调（t31/S9 强断言用；不影响出站）
 * }
 */
export function createHttpPort(opts) {
  const o = asObject(opts)
  const clock = typeof o.now === 'function' ? o.now : () => Date.now()
  const doSleep = typeof o.sleep === 'function' ? o.sleep : (ms) => new Promise((r) => setTimeout(r, ms))
  const timeoutMs = Number.isFinite(o.timeoutMs) ? o.timeoutMs : OUTBOUND_TIMEOUT_MS
  const maxRetries = Number.isFinite(o.maxRetries) ? o.maxRetries : MAX_RETRIES
  const backoffs = Array.isArray(o.retryBackoffMs) && o.retryBackoffMs.length ? o.retryBackoffMs : RETRY_BACKOFF_MS
  const minInterval = Number.isFinite(o.minAccountIntervalMs) ? o.minAccountIntervalMs : MIN_ACCOUNT_INTERVAL_MS
  const overrides = asObject(asObject(o.endpoints).hostOverrides)
  const transport = typeof o.transport === 'function' ? o.transport : createDefaultApiTransport({ timeoutMs })

  const lastAtByAccount = {}
  let lastAccountKey = null
  let lastAtMs = null
  // 数据面（只用于读 salts；**绝不**读凭据文件内容，§4.2）——支持 apply 在 core 构造后延迟绑定
  let storeRef = o.store && typeof o.store.readSalts === 'function' ? o.store : null
  const stats = { requests: 0, attempts: 0, rejectedBeforeSend: 0, retries: 0, waits: { sameAccountMs: 0, accountGapMs: 0 }, byCode: {} }

  function note(code) {
    if (!code) return
    stats.byCode[code] = (stats.byCode[code] || 0) + 1
  }

  function reject(code, message, detail, spec) {
    stats.rejectedBeforeSend++
    note(code)
    return {
      ok: false, code, classify: code === API_ERR.HOST_NOT_ALLOWED || code === API_ERR.BAD_ARG ? API_ERR.BAD_ARG : code,
      httpStatus: null, retcode: null, message, data: null, detail: detail === undefined ? null : detail,
      endpoint: spec && spec.path ? spec.path : null, host: spec && spec.host ? spec.host : null,
      sent: false, attempts: [], attemptsUsed: 0,
    }
  }

  /** §10.2 ④：限速（同账号 ≥1s；账号间 5–25s 抖动）；等待量进 stats 便于自测断言 */
  async function applyRateLimit(accountKey) {
    const key = typeof accountKey === 'string' && accountKey ? accountKey : null
    const t = clock()
    if (lastAtMs !== null && key !== null && lastAccountKey !== null && key !== lastAccountKey) {
      const gap = accountGapFor(key, localDateOf(t))
      const elapsed = t - lastAtMs
      if (elapsed < gap) {
        const wait = gap - elapsed
        stats.waits.accountGapMs += wait
        await doSleep(wait)
      }
    } else if (lastAtMs !== null && key !== null && lastAtByAccount[key] !== undefined) {
      const elapsed = t - lastAtByAccount[key]
      if (elapsed < minInterval) {
        const wait = minInterval - elapsed
        stats.waits.sameAccountMs += wait
        await doSleep(wait)
      }
    }
    const after = clock()
    lastAtMs = after
    if (key !== null) lastAtByAccount[key] = after
    lastAccountKey = key
  }

  async function fetchOnce(spec, headers, body) {
    const started = clock()
    const controller = typeof AbortController === 'function' ? new AbortController() : null
    let timer = null
    if (controller) timer = setTimeout(() => { controller.abort() }, timeoutMs)
    try {
      const init = { method: spec.method, headers }
      if (body !== undefined) init.body = body
      if (controller) init.signal = controller.signal
      const res = await transport(spec.url, init)
      const httpStatus = res && Number.isFinite(res.status) ? res.status : null
      let text = null
      if (res && typeof res.text === 'function') text = await res.text()
      let parsed = null
      let parseOk = false
      if (typeof text === 'string') {
        try { parsed = JSON.parse(text); parseOk = true } catch (e) { parseOk = false }
      }
      const p = asObject(parsed)
      return {
        httpStatus, parseOk, text: null,
        retcode: Number.isFinite(p.retcode) ? p.retcode : null,
        message: typeof p.message === 'string' ? p.message : null,
        data: p.data === undefined ? null : p.data,
        ms: clock() - started, timedOut: false, transportError: null,
      }
    } catch (e) {
      const timedOut = !!(e && (e.name === 'AbortError' || e.code === 'ABORT_ERR'))
      const isOutbound = e instanceof OutboundError
      return {
        httpStatus: null, parseOk: false, text: null, retcode: null, message: null, data: null,
        ms: clock() - started, timedOut,
        transportError: isOutbound ? e.code + ': ' + e.message : (e && e.message ? String(e.message) : String(e)),
      }
    } finally {
      if (timer !== null) clearTimeout(timer)
    }
  }

  /**
   * §10.2 出站请求（薄封装）：构造头 → 白名单/凭据/核验盐三道前置 → 限速 → 至多 3 次尝试 → 归一化。
   * 任一道前置不通过 ⇒ **不发请求**（返回 `sent:false`）。
   */
  async function request(req) {
    const r = asObject(req)
    let spec
    try {
      spec = resolveEndpointSpec(r, { hostOverrides: overrides })
    } catch (e) {
      const code = e instanceof OutboundError ? e.code : API_ERR.BAD_ARG
      return reject(code, e && e.message ? String(e.message) : 'URL 解析失败', e && e.detail ? String(e.detail) : null, null)
    }
    stats.requests++

    const accountKey = typeof r.accountKey === 'string' && r.accountKey ? r.accountKey : (typeof o.accountKey === 'string' ? o.accountKey : null)
    const signGame = typeof r.signGame === 'string' && r.signGame
      ? r.signGame
      : (spec.path.indexOf('/lun') === 0 || spec.path.indexOf('/luna/') >= 0 || /\/luna\//.test(spec.path))
        ? (typeof spec.target === 'string' && ['hk4e', 'hkrpg', 'zzz', 'bh3'].includes(spec.target) ? spec.target : null)
        : null

    // 前置 ①：**已核验的盐材料**（§3.1 成对约束；本条件无条件成立，与是否有凭据无关）
    let signing = { ok: true, appVersion: null, signingMaterial: null }
    if (r.needSignature !== false) {
      const salts = storeRef ? await storeRef.readSalts() : asObject(o.salts)
      signing = resolveSigningContext(salts)
      if (!signing.ok) return reject(signing.code, '出站签名前置不满足（§3.1/§3.5.4）：' + signing.detail, signing.detail, spec)
    }

    // 前置 ②：凭据（§4.2；本模块不读凭据文件内容，值由注入的 provider 给出）
    const credential = await resolveProvided(o.credentialProvider, typeof o.credential === 'string' ? o.credential : null)
    if (!credential && r.needAuth !== false) {
      return reject(API_ERR.AUTH_REQUIRED, '尚未注入可用凭据（凭据由调用方注入；本模块不读凭据文件内容，§4.2）', 'credentialProvider 返回空', spec)
    }

    // 前置 ③：限速（§10.2 ④）
    await applyRateLimit(accountKey)

    const t0 = clock()
    const tSec = Math.floor(t0 / 1000)
    const headers = buildApiHeaders({
      accountKey, appVersion: signing.appVersion || o.appVersion, credential,
      signingMaterial: signing.signingMaterial, t: tSec, r: o.r,
      deviceId: r.deviceId, signGame,
      referer: r.referer === undefined ? 'https://act.mihoyo.com/' : r.referer,
      origin: r.origin === undefined ? 'https://act.mihoyo.com' : r.origin,
    })
    const body = r.body === undefined ? undefined : (typeof r.body === 'string' ? r.body : JSON.stringify(r.body))
    // t43 最小 additive：允许调用方显式声明 **Content-Type**（默认不带 ⇒ 旧行为逐字不变）。
    // 用途：`luna/sign` 的 form-urlencoded 请求体（锚点 `gsuid_core/utils/api/mys/sign_request.py` 用 `data=`）
    // 必须带 `Content-Type: application/x-www-form-urlencoded`；仅在有 body 时生效。
    if (body !== undefined && typeof r.contentType === 'string' && r.contentType) {
      headers['Content-Type'] = r.contentType
    }
    // t31/S9 观测钩子：**头对象构造后**回调（只用于自测/运维核对"是否构造过带凭据的头对象"；观测失败不影响出站）
    if (typeof o.onHeadersBuilt === 'function') { try { o.onHeadersBuilt(headers, spec) } catch (e) { /* 忽略观测异常 */ } }
    const attempts = []
    let last = null
    for (let n = 1; n <= maxRetries + 1; n++) {
      stats.attempts++
      const got = await fetchOnce(spec, headers, body)
      last = got
      const verdict = classifyOutcome(got)
      attempts.push({
        n, httpStatus: got.httpStatus, retcode: got.retcode, code: verdict.code,
        timedOut: got.timedOut, transportError: got.transportError, ms: got.ms,
      })
      if (verdict.code === null) {
        return {
          ok: true, code: null, classify: null, httpStatus: got.httpStatus, retcode: got.retcode,
          message: got.message, data: got.data, endpoint: spec.path, host: spec.host, method: spec.method,
          sent: true, attempts, attemptsUsed: n, retriesUsed: n - 1, elapsedMs: clock() - t0,
          headerNames: Object.keys(headers).slice(),
        }
      }
      if (!verdict.retryable || n > maxRetries) {
        note(verdict.code)
        return {
          ok: false, code: verdict.code, classify: verdict.code, httpStatus: got.httpStatus, retcode: got.retcode,
          message: got.message, data: got.data, detail: got.transportError || (got.timedOut ? '超时（' + timeoutMs + 'ms）' : null),
          endpoint: spec.path, host: spec.host, method: spec.method, sent: true,
          attempts, attemptsUsed: n, retriesUsed: n - 1, elapsedMs: clock() - t0,
        }
      }
      stats.retries++
      const wait = backoffs[Math.min(n - 1, backoffs.length - 1)]
      await doSleep(wait)
    }
    note(API_ERR.NET_ERROR)
    return {
      ok: false, code: API_ERR.NET_ERROR, classify: API_ERR.NET_ERROR, httpStatus: last ? last.httpStatus : null,
      retcode: null, message: null, data: null, detail: '重试穷尽', endpoint: spec.path, host: spec.host,
      method: spec.method, sent: true, attempts, attemptsUsed: attempts.length, elapsedMs: clock() - t0,
    }
  }

  return {
    request,
    /** apply 在 core 构造后延迟绑定数据面（只用于读 salts） */
    bindStore(nextStore) { storeRef = nextStore && typeof nextStore.readSalts === 'function' ? nextStore : storeRef; return this },
    describe() {
      return {
        kind: 'mys-http',
        allowedHosts: ALLOWED_API_HOSTS.slice(),
        timeoutMs, maxRetries, backoffs: backoffs.slice(), minInterval,
        gaps: [ACCOUNT_GAP_MIN_MS, ACCOUNT_GAP_MAX_MS],
        transport: transport === null ? null : 'injected-or-default',
        credentialProviderPresent: typeof o.credentialProvider === 'function',
        headerObserverPresent: typeof o.onHeadersBuilt === 'function',
      }
    },
    stats() { return JSON.parse(JSON.stringify(stats)) },
  }
}
