// @local/version-radar —— routes.js：**零 dsh 依赖**的纯路由 / secret 逻辑（可本机单测）
//
// 为什么单独拆：lib/index.js 必须 import 宿主机才有的 dsh-tools 包 ⇒ index.js 本机无法被 import、
// 无法单测。⇒ 把「能测的」全放这里：路由分发 + secret fail-closed。
// 本文件**不引任何 dsh 包、不联网**（/status 永不联网；/check 的联网发生在**注入的** runCheck 里）。

import fsDefault from 'node:fs'
import crypto from 'node:crypto'

export const API_PREFIX = '/version-radar/api'
const STALE_MS = 5 * 60 * 1000
const ALLOWED_METHODS = { '/status': 'GET', '/check': 'POST' }

/** 常数时间比较（长度不同也走一次等长 digest 比较；值不外泄） */
export function timingSafeEqualStr(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest()
  const hb = crypto.createHash('sha256').update(String(b)).digest()
  return crypto.timingSafeEqual(ha, hb)
}

/**
 * secret 读取（**只读，绝不回显值**）。顺序（spec §5.2）：
 *   ① config.httpSecretFile（推荐：manifest 只留路径，不留明文）
 *   ② config.httpSecret
 *   ③ 环境变量 DSH_VERSION_RADAR_HTTP_SECRET
 * 都没配 ⇒ { secret:null } ⇒ /check 一律 403（fail-closed）。
 */
export function resolveSecret(opts) {
  const o = opts || {}
  const fs = o.fs || fsDefault
  const env = o.env || process.env || {}
  const c = (o.config && typeof o.config === 'object') ? o.config : {}
  const fp = c.httpSecretFile
  if (typeof fp === 'string' && fp.trim()) {
    try {
      const v = String(fs.readFileSync(fp.trim(), 'utf8')).trim()
      if (v) return { secret: v, source: 'file:' + fp.trim() }
      return { secret: null, source: 'file-empty:' + fp.trim() }
    } catch (_) {
      return { secret: null, source: 'file-unreadable:' + fp.trim() }
    }
  }
  if (typeof c.httpSecret === 'string' && c.httpSecret.trim()) return { secret: c.httpSecret.trim(), source: 'config:httpSecret' }
  const envV = String(env.DSH_VERSION_RADAR_HTTP_SECRET || '').trim()
  if (envV) return { secret: envV, source: 'env:DSH_VERSION_RADAR_HTTP_SECRET' }
  return { secret: null, source: null }
}

/** 允许调用方传完整 path 或已剥前缀的 path */
function tailPath(path) {
  const p = String(path || '')
  if (p === API_PREFIX) return '/'
  if (p.startsWith(API_PREFIX + '/')) return p.slice(API_PREFIX.length)
  return p
}

/**
 * 纯路由：({ method, path, query, headers, config, deps }) → { status, body }
 * deps = { getLastResult, runCheck, resolveSecret?, fs?, env?, now? }
 *   getLastResult() → { lastRunAt: string|null, result: object|null }
 *   runCheck({ via, report }) → Promise<object>
 */
export async function buildResponse(req) {
  const r = req || {}
  const method = String(r.method || 'GET').toUpperCase()
  const tail = tailPath(r.path)
  const query = (r.query && typeof r.query === 'object') ? r.query : {}
  const headers = (r.headers && typeof r.headers === 'object') ? r.headers : {}
  const config = r.config || {}
  const deps = r.deps || {}
  const now = (typeof deps.now === 'function') ? deps.now : (() => Date.now())
  const send = (status, body) => ({ status, body })

  if (!Object.prototype.hasOwnProperty.call(ALLOWED_METHODS, tail)) {
    return send(404, { ok: false, code: 'NOT_FOUND', message: '已知路由：' + API_PREFIX + '/status（GET）、' + API_PREFIX + '/check（POST）' })
  }
  if (method !== ALLOWED_METHODS[tail]) {
    return send(405, { ok: false, code: 'METHOD_NOT_ALLOWED', message: tail + ' 只接受 ' + ALLOWED_METHODS[tail] })
  }

  if (tail === '/status') {
    // ⚠️ 永不联网：只读进程内最近一次结果（spec §5.2 / §6-1）
    const last = (typeof deps.getLastResult === 'function') ? (deps.getLastResult() || {}) : {}
    const lastRunAt = last.lastRunAt || null
    const age = lastRunAt ? (now() - Date.parse(lastRunAt)) : NaN
    const stale = !lastRunAt || !Number.isFinite(age) || age > STALE_MS
    return send(200, {
      ok: true, route: '/status', lastRunAt, stale,
      result: last.result || null,
      note: '本路由只回进程内缓存，永不联网',
    })
  }

  // /check：secret fail-closed（未配 ⇒ 403；配了但错 ⇒ 403）
  const resolved = (typeof deps.resolveSecret === 'function')
    ? deps.resolveSecret()
    : resolveSecret({ config, fs: deps.fs, env: deps.env })
  const expected = resolved && resolved.secret
  const presented = String(headers['x-version-radar-token'] || headers['X-Version-Radar-Token'] || '')
  if (!expected) {
    return send(403, {
      ok: false, code: 'CHECK_DISABLED_NO_SECRET',
      message: '未配置 HTTP secret ⇒ /check 一律拒绝（fail-closed）。请设 manifest 的 config.httpSecretFile / config.httpSecret，或环境变量 DSH_VERSION_RADAR_HTTP_SECRET。',
    })
  }
  if (!presented || !timingSafeEqualStr(presented, expected)) {
    return send(403, { ok: false, code: 'BAD_TOKEN', message: 'x-version-radar-token 缺失或不匹配（值不外泄）' })
  }
  const wantReport = query.report === '1' || query.report === 1 || query.report === true || query.report === 'true'
  let result
  try {
    result = await deps.runCheck({ via: 'http', report: wantReport })
  } catch (e) {
    return send(500, { ok: false, code: 'CHECK_FAILED', message: String((e && e.message) || e) })
  }
  return send(200, { ok: true, route: '/check', report: wantReport, result: result || null })
}

export { ALLOWED_METHODS, STALE_MS }
