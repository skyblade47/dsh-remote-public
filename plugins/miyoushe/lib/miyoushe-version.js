// @local/miyoushe —— 版本↔盐耦合层（设计 §3.5）。**纯函数为主**，唯一的 IO 例外＝§3.5.8 的**受控出站**默认实现
//   （`createDefaultVersionFetch`）：本文件是 `lib/**` 中**唯一**允许调用全局 fetch 的地方
//   （静态断言：本文件 fetch 调用计数恒为 1，其余 lib 文件恒为 0）。
//
// 设计锚点（**按章节锚点 + grep 模式引用，不写行号**——设计文档自指行号已漂移）：
//   §3.5.4 salts.json 结构（**版本为键**）  锚：grep 模式 `salts.json. 结构（\*\*版本为键\*\*）`
//   §3.5.4 覆盖纪律（防悄悄换盐）            锚：grep 模式 `覆盖. 纪律（防`
//   §3.5.6 降级链路（SALT_MISSING/VERSION_STALE/VERSION_FETCH_FAILED/SALT_INVALID）
//   §3.5.7 fingerprint 口径                 锚：grep 模式 `fingerprint\(salt\) = sha256`
//   §3.5.8 出站（8s 超时 / 最多 1 次重试 / 固定 UA / 域名白名单 / 绝不携带凭据）
//
// 纪律：
//   1) **网络默认不启用**：`fetchVersionCandidates` 仍只接受 `opts.fetchImpl`（函数）；本文件新增的
//      受控默认出站（`createDefaultVersionFetch`，§3.5.8）**只由生产接线 `apply`（lib/index.js）**在
//      未注入时注入 ⇒ 离线自测（只调 `createCore` / `createActions`）未注入时仍返回 `VERSION_FETCH_FAILED`，
//      且**全程不触碰**全局 fetch（哨兵调用数=0）。未注入 ⇒ `VERSION_FETCH_FAILED`（**不静默、不回落**）。
//   2) `fingerprint()` 与 §3.5.7 / §6.5.1 G2③ 共用**同一实现**（委托 `lib/mask.js` 的 `saltFingerprint`），
//      本包装只补"非法输入 ⇒ `FP_BAD_SALT`"这一层。
//   3) 纯函数：不写盘、不改入参（`mergeCandidate` 返回**新对象**）。
//   4) 版本**不构成**盐失效的证据（§3.5.10 漂移判据）：本模块只产出 `matchResult` 与降级码，
//      **绝不**输出 `SALT_SUSPECT`。

import { saltFingerprint } from './mask.js'

export const CACHE_TTL_MS = 86400000 // §3.5.4：默认 24h；0＝禁用缓存
export const FETCH_TIMEOUT_MS = 8000 // §3.5.8：连接+读取合计 8s
export const MAX_ATTEMPTS = 2 // §3.5.8：最多 1 次重试（S1 → S2）
export const CLIENT_TYPE_WEB = '5' // §2.3：本插件用 client_type=5 ⇒ 取 `_web` 盐（§3.5.4 注①）
export const SALT_LENGTH = 32

export const VERSION_ERR = Object.freeze({
  FP_BAD_SALT: 'FP_BAD_SALT',
  SALT_SHAPE_INVALID: 'SALT_SHAPE_INVALID',
  SALT_INVALID: 'SALT_INVALID',
  SALT_MISSING: 'SALT_MISSING',
  VERSION_STALE: 'VERSION_STALE',
  VERSION_FETCH_FAILED: 'VERSION_FETCH_FAILED',
  VERSION_SOURCE_NOT_ALLOWED: 'VERSION_SOURCE_NOT_ALLOWED',
  BAD_ARG: 'BAD_ARG',
})

/** §3.5.2 可用源（S1 主源 / S2 镜像）；只用这两个固定 URL，不接受调用方传入任意地址以外的白名单外域名 */
export const VERSION_SOURCES = Object.freeze([
  { id: 'S1', url: 'https://raw.githubusercontent.com/Womsxd/MihoyoBBSTools/master/setting.py' },
  { id: 'S2', url: 'https://raw.gitcode.com/Womsxd/MihoyoBBSTools/raw/master/setting.py' },
])

/** §3.5.8 域名白名单（第三方源；**任何**情况下不携带凭据） */
export const ALLOWED_SOURCE_HOSTS = Object.freeze([
  'raw.githubusercontent.com', 'raw.gitcode.com', 'api.github.com',
])

const UA_PREFIX = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 miHoYoBBS/'

export class VersionError extends Error {
  constructor(code, message, detail) {
    super(message)
    this.name = 'VersionError'
    this.code = code
    this.detail = detail === undefined || detail === null ? null : String(detail)
  }
}

const asObject = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {})

/**
 * 盐指纹（§3.5.7 口径：sha256(salt,'utf8') 前 8 位**小写**；与 mask.js 同一实现）。
 * 非法输入 ⇒ `VersionError('FP_BAD_SALT')`。
 */
export function fingerprint(salt) {
  if (typeof salt !== 'string' || salt.length === 0) {
    throw new VersionError(VERSION_ERR.FP_BAD_SALT, "fingerprint(salt) 只接受非空字符串（§3.5.7 口径）", 'typeof=' + typeof salt)
  }
  const fp = saltFingerprint(salt)
  if (typeof fp !== 'string' || !/^[0-9a-f]{8}$/.test(fp)) {
    throw new VersionError(VERSION_ERR.FP_BAD_SALT, 'fingerprint 结果形状异常', String(fp))
  }
  return fp
}

/** 安全的指纹（不抛）：非法输入返回 null，便于门禁侧做"无盐 ⇒ 不合格"判定 */
export function fingerprintOrNull(salt) {
  try { return fingerprint(salt) } catch (e) { return null }
}

/** 盐形状（§3.5.4：32 位字符串；不符 ⇒ 取回即拒，不落盘） */
export function isSaltShape(salt) {
  return typeof salt === 'string' && new RegExp('^[0-9a-fA-F]{' + SALT_LENGTH + '}$').test(salt)
}

/** 解析 S1/S2 的 `setting.py` 原文（§3.5.3 的字段名；**第一次出现**为配置值） */
export function parseSettingPy(text) {
  const s = typeof text === 'string' ? text : ''
  const pick = (name) => {
    const m = new RegExp('^\\s*' + name + '\\s*=\\s*"([^"]*)"', 'm').exec(s)
    return m ? m[1] : null
  }
  const appVersion = pick('mihoyobbs_version')
  const appSalt = pick('mihoyobbs_salt')
  const webSalt = pick('mihoyobbs_salt_web')
  return {
    appVersion,
    appSalt,
    webSalt,
    appSaltFingerprint: fingerprintOrNull(appSalt),
    webSaltFingerprint: fingerprintOrNull(webSalt),
    saltShapeOk: { app: isSaltShape(appSalt), web: isSaltShape(webSalt) },
    parsed: appVersion !== null || appSalt !== null || webSalt !== null,
  }
}

/**
 * 取回结果 → **候选条目**（纯映射；不落盘、不改 salts）。
 * 取盐规则（§3.5.4 注①）：`client_type=5` ⇒ 取 `_web` 项。
 * 形状不符 ⇒ `SALT_SHAPE_INVALID`（**不落盘**，§3.5.4）。
 */
export function buildCandidateEntry(parsed, opts) {
  const o = asObject(opts)
  const p = asObject(parsed)
  const clientType = o.clientType === undefined || o.clientType === null ? CLIENT_TYPE_WEB : String(o.clientType)
  const salt = clientType === CLIENT_TYPE_WEB ? p.webSalt : p.appSalt
  const appVersion = typeof p.appVersion === 'string' && p.appVersion ? p.appVersion : null
  if (appVersion === null) {
    throw new VersionError(VERSION_ERR.SALT_SHAPE_INVALID, '取回内容里没有可用的 mihoyobbs_version（无法作为版本键）', 'appVersion=null')
  }
  if (!isSaltShape(salt)) {
    throw new VersionError(VERSION_ERR.SALT_SHAPE_INVALID, '取回的盐形状不符（要求 ' + SALT_LENGTH + ' 位 hex）⇒ 取回即拒、不落盘（§3.5.4）', 'salt=' + (typeof salt === 'string' ? salt.length + ' chars' : String(salt)))
  }
  const fetchedAt = typeof o.fetchedAt === 'string' && o.fetchedAt ? o.fetchedAt : null
  return {
    appVersion,
    entry: {
      clientType,
      salt,
      saltFingerprint: fingerprint(salt),
      status: 'unverified-current', // §3.5.4：自动取回的新条目一律 unverified-current
      source: o.source === undefined ? null : o.source,
      sourceKind: 'auto',
      sourceUrl: o.sourceUrl === undefined ? null : o.sourceUrl,
      fetchedAt,
      verifiedAt: null,
      rejectedAt: null,
      probeResult: null,
    },
  }
}

/** 缓存 TTL 判定（§3.5.4 缓存策略）：`now - fetchedAt < ttlMs` 且 `lastFetchOk=true` ⇒ 直接用缓存 */
export function cacheState(versionCache, now, opts) {
  const o = asObject(opts)
  const ttlMs = Number.isFinite(o.ttlMs) ? o.ttlMs : CACHE_TTL_MS
  const vc = asObject(versionCache)
  const fetchedAt = typeof vc.fetchedAt === 'string' ? vc.fetchedAt : null
  const atMs = fetchedAt === null ? NaN : Date.parse(fetchedAt)
  const ageMs = Number.isFinite(atMs) ? now - atMs : null
  if (ttlMs <= 0) return { fresh: false, ageMs, ttlMs, reason: 'ttl_disabled' }
  if (fetchedAt === null || !Number.isFinite(atMs)) return { fresh: false, ageMs, ttlMs, reason: 'no_cache' }
  if (vc.lastFetchOk === false) return { fresh: false, ageMs, ttlMs, reason: 'last_fetch_failed' }
  if (ageMs >= ttlMs) return { fresh: false, ageMs, ttlMs, reason: 'expired' }
  return { fresh: true, ageMs, ttlMs, reason: 'fresh' }
}

/** 是否需要打网络：缓存不新鲜，或用户显式 refresh */
export function shouldFetch(versionCache, now, opts) {
  const o = asObject(opts)
  if (o.refresh === true) return true
  return cacheState(versionCache, now, o).fresh !== true
}

/** 版本 → 匹配结论（§3.5.7 的 `matchResult`：hit｜missing｜rejected｜conflict） */
export function matchVersion(salts, appVersion, opts) {
  const o = asObject(opts)
  const entries = asObject(asObject(salts).entries)
  const entry = appVersion && entries[appVersion] && typeof entries[appVersion] === 'object' ? entries[appVersion] : null
  if (!entry) return 'missing'
  if (entry.status === 'rejected') return 'rejected'
  if (typeof o.fetchedSalt === 'string' && typeof entry.salt === 'string' && entry.salt !== o.fetchedSalt) return 'conflict'
  return 'hit'
}

/**
 * 取回候选 → 合并进 salts（§3.5.4「覆盖纪律」；返回**新对象**，不改入参）。
 *   - 既有条目 `status:'verified'`：**绝不覆盖**；同版本冲突 ⇒ `conflict`（只记审计，提示人工确认）
 *   - 既有条目 `sourceKind:'manual'`：**永不被自动覆盖**
 *   - 既有条目 `status ∈ {unverified-current, stale}`：允许原位更新 salt + fetchedAt，status 重置 `unverified-current`
 *   - 无该版本键：**只新增**
 */
export function mergeCandidate(salts, candidate, opts) {
  const o = asObject(opts)
  const nowIso = typeof o.nowIso === 'string' && o.nowIso ? o.nowIso : new Date(Number.isFinite(o.now) ? o.now : Date.now()).toISOString()
  const src = asObject(salts)
  const cand = asObject(candidate)
  const appVersion = typeof cand.appVersion === 'string' ? cand.appVersion : null
  if (appVersion === null) throw new VersionError(VERSION_ERR.BAD_ARG, 'mergeCandidate 需要 candidate.appVersion 作为版本键')
  const nextEntry = asObject(cand.entry)
  const out = {
    version: src.version === undefined ? 2 : src.version,
    updatedAt: nowIso,
    active: src.active === undefined ? null : src.active,
    entries: Object.assign({}, asObject(src.entries)),
    versionCache: src.versionCache === undefined ? null : src.versionCache,
  }
  const prev = out.entries[appVersion] && typeof out.entries[appVersion] === 'object' ? out.entries[appVersion] : null
  const audit = {
    ts: nowIso,
    event: 'version.change',
    fromVersion: asObject(src.active).appVersion === undefined ? null : asObject(src.active).appVersion,
    toVersion: appVersion,
    saltFingerprint: nextEntry.saltFingerprint === undefined ? fingerprintOrNull(nextEntry.salt) : nextEntry.saltFingerprint,
    sourceUrl: nextEntry.sourceUrl === undefined ? null : nextEntry.sourceUrl,
    sourceKind: 'auto',
    fetchHttpStatus: o.fetchHttpStatus === undefined ? null : o.fetchHttpStatus,
    fetchError: o.fetchError === undefined ? null : o.fetchError,
    matchResult: 'hit',
    downgrade: 'none',
    errorCode: null,
  }
  if (!prev) {
    out.entries[appVersion] = nextEntry
    audit.matchResult = 'hit'
    return { salts: out, action: 'inserted', audit }
  }
  if (prev.status === 'verified') {
    audit.matchResult = prev.salt === nextEntry.salt ? 'hit' : 'conflict'
    audit.event = 'version.auto_conflict'
    if (prev.salt !== nextEntry.salt) {
      audit.errorCode = null
      audit.downgrade = 'none'
      return { salts: out, action: 'conflict', audit }
    }
    return { salts: out, action: 'unchanged', audit }
  }
  if (prev.sourceKind === 'manual') {
    audit.matchResult = prev.salt === nextEntry.salt ? 'hit' : 'conflict'
    audit.event = 'version.auto_conflict'
    return { salts: out, action: 'kept-manual', audit }
  }
  out.entries[appVersion] = Object.assign({}, prev, {
    clientType: nextEntry.clientType,
    salt: nextEntry.salt,
    saltFingerprint: nextEntry.saltFingerprint,
    status: 'unverified-current',
    source: nextEntry.source === undefined ? prev.source : nextEntry.source,
    sourceKind: 'auto',
    sourceUrl: nextEntry.sourceUrl === undefined ? prev.sourceUrl : nextEntry.sourceUrl,
    fetchedAt: nextEntry.fetchedAt === undefined ? nowIso : nextEntry.fetchedAt,
    verifiedAt: null,
    rejectedAt: null,
  })
  return { salts: out, action: 'updated', audit }
}

/** 版本陈旧度（§3.5.6：`now - fetchedAt > ttlMs×3` 或 `lastFetchOk=false` ⇒ VERSION_STALE） */
export function evaluateVersionStaleness(salts, now, opts) {
  const ttlMs = Number.isFinite(asObject(opts).ttlMs) ? asObject(opts).ttlMs : CACHE_TTL_MS
  const vc = asObject(asObject(salts).versionCache)
  const fetchedAt = typeof vc.fetchedAt === 'string' ? vc.fetchedAt : null
  const atMs = fetchedAt === null ? NaN : Date.parse(fetchedAt)
  const ageMs = Number.isFinite(atMs) ? now - atMs : null
  if (vc.lastFetchOk === false) {
    return { stale: true, code: VERSION_ERR.VERSION_STALE, ageMs, detail: 'versionCache.lastFetchOk=false（最近一次取回失败，原因=' + JSON.stringify(vc.lastFetchError === undefined ? null : vc.lastFetchError) + '）' }
  }
  if (ageMs === null) {
    return { stale: true, code: VERSION_ERR.VERSION_STALE, ageMs: null, detail: 'versionCache.fetchedAt 缺失或不可解析' }
  }
  if (ageMs > ttlMs * 3) {
    return { stale: true, code: VERSION_ERR.VERSION_STALE, ageMs, detail: '版本信息已过期：ageMs=' + ageMs + ' > ttlMs×3=' + ttlMs * 3 }
  }
  return { stale: false, code: null, ageMs, detail: null }
}

/** 域名白名单校验（§3.5.8 硬约束）：非白名单一律拒绝 */
export function assertAllowedSource(url) {
  let host = null
  try { host = new URL(String(url)).hostname.toLowerCase() } catch (e) { host = null }
  if (host === null || !ALLOWED_SOURCE_HOSTS.includes(host)) {
    throw new VersionError(VERSION_ERR.VERSION_SOURCE_NOT_ALLOWED, '版本源不在白名单内（§3.5.8）：' + String(url), 'host=' + String(host))
  }
  return host
}

/**
 * 构造请求（§3.5.8）：固定 UA（含 `miHoYoBBS/<配置版本>`）、**仅** UA/Accept 两个头、不跟随任何凭据。
 * 返回值可直接交给注入的 fetchImpl。
 */
export function buildVersionRequest(url, opts) {
  const o = asObject(opts)
  assertAllowedSource(url)
  const appVersion = typeof o.appVersion === 'string' && o.appVersion ? o.appVersion : 'unknown'
  const init = {
    method: 'GET',
    redirect: 'follow',
    headers: {
      'User-Agent': UA_PREFIX + appVersion,
      Accept: 'text/plain',
    },
  }
  return { url: String(url), init }
}

// ---------------------------------------------------------------------------
// §3.5.8 **受控出站的默认实现**（本文件＝`lib/**` 中唯一的全局出站点；静态断言 fetch 调用计数恒为 1）
//   - 白名单：非白名单主机 ⇒ 抛 `VersionError(VERSION_SOURCE_NOT_ALLOWED)`（结构化拒绝，**不静默、不回落**）
//   - 请求头：只保留 UA / Accept 两个白名单头；任何其它头（凭据 / 签名 / 追踪）**一律丢弃**
//   - 固定 UA：`Mozilla/5.0 … miHoYoBBS/<配置版本>`（传入的 UA 不合该前缀 ⇒ 直接替换）
//   - 超时：`timeoutMs`（默认 8000，§3.5.8 连接+读取合计）经 AbortController 中止，并串联调用方 signal
//   - 换源：由 `fetchVersionCandidates` 决定（S1→S2，最多 1 次）；本函数只负责**一次**请求
// ---------------------------------------------------------------------------
export const OUTBOUND_ALLOWED_HEADERS = Object.freeze(['user-agent', 'accept'])

/** 固定 UA（§3.5.8）：`miHoYoBBS/<配置版本>`；版本未知时用 `unknown` */
function uaForVersion(appVersion) {
  return UA_PREFIX + (typeof appVersion === 'string' && appVersion ? appVersion : 'unknown')
}

/** 只保留白名单头的**逐字**拷贝（其余头一律丢弃 ⇒ 零凭据）；缺失或不合固定 UA 时用固定值补齐 */
export function pickAllowedOutboundHeaders(headers, opts) {
  const src = asObject(headers)
  const o = asObject(opts)
  const out = {}
  for (const k of Object.keys(src)) {
    if (OUTBOUND_ALLOWED_HEADERS.includes(k.toLowerCase())) out[k] = String(src[k])
  }
  const lc = Object.keys(out).map((k) => k.toLowerCase())
  if (!lc.includes('user-agent')) {
    out['User-Agent'] = uaForVersion(o.appVersion)
  } else {
    const cur = out['User-Agent'] === undefined ? out['user-agent'] : out['User-Agent']
    if (!String(cur).startsWith(UA_PREFIX)) {
      delete out['User-Agent']
      delete out['user-agent']
      out['User-Agent'] = uaForVersion(o.appVersion)
    }
  }
  if (!lc.includes('accept')) out.Accept = 'text/plain'
  return out
}

/** 唯一的全局 fetch 调用点（§3.5.8 落点；静态断言：本文件 fetch 调用计数 = 1） */
async function outboundGet(url, init) {
  return await fetch(url, init)
}

/**
 * §3.5.8 受控出站的**默认实现**（生产接线 `apply` 在未注入 `fetchImpl` 时注入）。
 * @param opts { appVersion?, timeoutMs? }
 * @returns transport `(url, init) => Promise<Response>`；**运行环境无全局 fetch ⇒ `null`**
 *          （此时保持"未注入"语义：`refresh` 显式 `VERSION_FETCH_FAILED`，绝不静默回落直连）。
 */
export function createDefaultVersionFetch(opts) {
  if (typeof globalThis.fetch !== 'function') return null
  const o = asObject(opts)
  const timeoutMs = Number.isFinite(o.timeoutMs) ? o.timeoutMs : FETCH_TIMEOUT_MS
  return async function defaultVersionFetch(url, init) {
    assertAllowedSource(url)
    const src = asObject(init)
    const headers = pickAllowedOutboundHeaders(src.headers, o)
    let timer = null
    let signal = src.signal
    if (typeof AbortController === 'function') {
      const ctrl = new AbortController()
      const outer = src.signal
      if (outer && typeof outer.addEventListener === 'function') {
        if (outer.aborted) { try { ctrl.abort() } catch (e) { /* 已中止 */ } }
        else outer.addEventListener('abort', () => { try { ctrl.abort() } catch (e) { /* 已中止 */ } }, { once: true })
      }
      timer = setTimeout(() => { try { ctrl.abort() } catch (e) { /* 已中止 */ } }, timeoutMs)
      signal = ctrl.signal
    }
    try {
      const req = {
        method: src.method === undefined ? 'GET' : src.method,
        redirect: src.redirect === undefined ? 'follow' : src.redirect,
        headers,
      }
      if (signal) req.signal = signal
      return await outboundGet(url, req)
    } finally {
      if (timer !== null) clearTimeout(timer)
    }
  }
}

/** 单次 GET（经注入的 fetchImpl）；返回 {ok, httpStatus, text, error} */
async function fetchOnce(fetchImpl, url, opts) {
  const { init } = buildVersionRequest(url, opts)
  const timeoutMs = Number.isFinite(asObject(opts).timeoutMs) ? asObject(opts).timeoutMs : FETCH_TIMEOUT_MS
  let timer = null
  let signal
  if (typeof AbortController === 'function') {
    const ctrl = new AbortController()
    signal = ctrl.signal
    timer = setTimeout(() => { try { ctrl.abort() } catch (e) { /* 忽略 */ } }, timeoutMs)
  }
  try {
    const req = Object.assign({}, init, signal ? { signal } : {})
    const res = await fetchImpl(url, req)
    const httpStatus = res && Number.isFinite(res.status) ? res.status : null
    if (!res || typeof res.text !== 'function') {
      return { ok: false, httpStatus, text: null, error: 'BAD_RESPONSE' }
    }
    const text = await res.text()
    return { ok: httpStatus === null ? true : (httpStatus >= 200 && httpStatus < 300), httpStatus, text, error: null }
  } catch (e) {
    return { ok: false, httpStatus: null, text: null, error: e && e.name === 'AbortError' ? 'TIMEOUT' : (e && e.code ? String(e.code) : 'NET_ERROR') }
  } finally {
    if (timer !== null) clearTimeout(timer)
  }
}

/**
 * 取回版本+盐（**注入式 fetch**；S1 → S2 最多 1 次重试；8s 超时）。
 * @param opts { fetchImpl, now?, timeoutMs?, appVersion?, sources?, refresh? }
 * @returns { ok, attempts[], httpStatus, appVersion|null, candidate|null, matchResult, code|null, sourceUrl }
 * 未注入 `fetchImpl` ⇒ `ok:false` + `code:'VERSION_FETCH_FAILED'`（**绝不**回落直连）。
 */
export async function fetchVersionCandidates(opts) {
  const o = asObject(opts)
  const fetchImpl = o.fetchImpl
  const now = Number.isFinite(o.now) ? o.now : Date.now()
  const attempts = []
  if (typeof fetchImpl !== 'function') {
    return {
      ok: false, attempts, httpStatus: null, appVersion: null, candidate: null,
      matchResult: 'missing', code: VERSION_ERR.VERSION_FETCH_FAILED, sourceUrl: null,
      detail: 'fetchImpl 未注入（本模块零直连：不接线阶段必须显式注入假/真 fetch）',
    }
  }
  const sources = Array.isArray(o.sources) && o.sources.length ? o.sources : VERSION_SOURCES
  const list = sources.slice(0, MAX_ATTEMPTS)
  let last = null
  let shapeCode = null
  let shapeParsed = null
  for (const src of list) {
    const url = src && src.url ? src.url : String(src)
    const sourceId = src && src.id ? src.id : 'S?'
    let attempt
    try {
      assertAllowedSource(url)
      attempt = await fetchOnce(fetchImpl, url, o)
    } catch (e) {
      attempt = { ok: false, httpStatus: null, text: null, error: e && e.code ? String(e.code) : 'BAD_URL' }
    }
    const rec = { sourceId, url, httpStatus: attempt.httpStatus, ok: attempt.ok, error: attempt.error }
    attempts.push(rec)
    last = { rec, attempt, url }
    if (attempt.ok && typeof attempt.text === 'string') {
      const parsed = parseSettingPy(attempt.text)
      try {
        const candidate = buildCandidateEntry(parsed, {
          clientType: o.clientType,
          source: 'T65 实测 ' + sourceId + '（Womsxd/MihoyoBBSTools setting.py）',
          sourceUrl: url,
          fetchedAt: new Date(now).toISOString(),
        })
        return { ok: true, attempts, httpStatus: rec.httpStatus, appVersion: candidate.appVersion, candidate, matchResult: 'hit', code: null, sourceUrl: url, parsed }
      } catch (e) {
        // HTTP 200 但内容不可用（缺版本键 / 盐形状不符）：**继续下一个源**（§3.5.8 换 S2 镜像），末尾再报错
        shapeCode = e && e.code ? e.code : VERSION_ERR.SALT_SHAPE_INVALID
        shapeParsed = parsed
        continue
      }
    }
  }
  if (shapeCode !== null) {
    return {
      ok: false, attempts, httpStatus: last ? last.rec.httpStatus : null,
      appVersion: shapeParsed ? shapeParsed.appVersion : null, candidate: null,
      matchResult: 'missing', code: shapeCode, sourceUrl: last ? last.url : null, parsed: shapeParsed,
      detail: '取回内容不可用（' + shapeCode + '）⇒ 取回即拒、不落盘（§3.5.4）',
    }
  }
  return {
    ok: false, attempts, httpStatus: last ? last.rec.httpStatus : null, appVersion: null, candidate: null,
    matchResult: 'missing', code: VERSION_ERR.VERSION_FETCH_FAILED, sourceUrl: last ? last.url : null,
    detail: 'S1+S2 均失败（§3.5.6 VERSION_FETCH_FAILED）',
  }
}

/**
 * 版本链路结论（§3.5.6 判定树的机器化；**不改 active**、不落盘）。
 * @returns { code|null, mode:'normal'|'readonly', matchResult, activeUnchanged:boolean, appVersion, detail }
 */
export function decideVersionOutcome(opts) {
  const o = asObject(opts)
  const salts = asObject(o.salts)
  const now = Number.isFinite(o.now) ? o.now : Date.now()
  const stale = evaluateVersionStaleness(salts, now, o)
  const fetchResult = asObject(o.fetchResult)
  const appVersion = typeof o.appVersion === 'string' && o.appVersion
    ? o.appVersion
    : (typeof fetchResult.appVersion === 'string' ? fetchResult.appVersion : null)

  if (!fetchResult.ok) {
    const attempts = Array.isArray(fetchResult.attempts) ? fetchResult.attempts : []
    const exhausted = attempts.length >= MAX_ATTEMPTS
    // §3.5.6：整体失败（S1+S2 均失败）⇒ VERSION_FETCH_FAILED；未被穷尽（单源/未尝试）⇒ VERSION_STALE；
    // 形状非法 ⇒ SALT_INVALID（拒绝该盐）；非白名单源 ⇒ 原码透出（便于定位配置问题）
    let code
    if (fetchResult.code === VERSION_ERR.SALT_SHAPE_INVALID) code = VERSION_ERR.SALT_INVALID
    else if (fetchResult.code === VERSION_ERR.VERSION_SOURCE_NOT_ALLOWED) code = VERSION_ERR.VERSION_SOURCE_NOT_ALLOWED
    else if (exhausted) code = VERSION_ERR.VERSION_FETCH_FAILED
    else code = stale.code || VERSION_ERR.VERSION_STALE
    return {
      code, mode: 'readonly', matchResult: 'missing', activeUnchanged: true, appVersion,
      detail: '取版本失败 ⇒ 回退配置版本、只读降级（code=' + code + '；attempts=' + attempts.length + '；' + String(fetchResult.detail || fetchResult.code || 'fetch failed') + '）',
    }
  }
  const matchResult = matchVersion(salts, appVersion, { fetchedSalt: asObject(fetchResult.candidate).entry ? asObject(fetchResult.candidate).entry.salt : undefined })
  if (matchResult === 'missing') {
    return {
      code: VERSION_ERR.SALT_MISSING, mode: 'readonly', matchResult, activeUnchanged: true, appVersion,
      detail: '已获取米游社当前版本 ' + JSON.stringify(appVersion) + '，但 salts.json.entries 中**无该版本键** ⇒ 降级只读；active **保持旧值不变**（不切到无盐的新版本，§3.5.6）',
    }
  }
  if (matchResult === 'rejected') {
    return {
      code: VERSION_ERR.SALT_INVALID, mode: 'readonly', matchResult, activeUnchanged: true, appVersion,
      detail: '该版本条目的 status 为 rejected（拒绝使用，§3.5.6）',
    }
  }
  const entry = asObject(asObject(salts).entries)[appVersion]
  if (entry && (entry.status === 'verified' || entry.status === 'unverified-current')) {
    const fp = fingerprintOrNull(entry.salt)
    if (fp === null) {
      return { code: VERSION_ERR.SALT_INVALID, mode: 'readonly', matchResult, activeUnchanged: true, appVersion, detail: '条目盐形状非法 ⇒ SALT_INVALID' }
    }
    return {
      code: null, mode: 'normal', matchResult: 'hit', activeUnchanged: true, appVersion,
      detail: '命中且 status=' + JSON.stringify(entry.status) + '（saltFingerprint=' + fp + '）；unverified 条目允许试签、禁止无人值守自动签到（§3.5.6）',
    }
  }
  if (matchResult === 'conflict') {
    return {
      code: null, mode: 'normal', matchResult: 'conflict', activeUnchanged: true, appVersion,
      detail: '上游同版本盐与本地已核验值不一致 ⇒ 未自动替换，请人工确认（§3.5.4 覆盖纪律 1）',
    }
  }
  return { code: null, mode: 'normal', matchResult, activeUnchanged: true, appVersion, detail: '命中' }
}
