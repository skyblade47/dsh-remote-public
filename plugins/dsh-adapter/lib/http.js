// @local/dsh-adapter —— AdapterHttp 实现（§4 接口全量）
// 标准化 loopback HTTP：apiBase 解析 / 默认 POST 避缓存 / 8s 超时 / 非2xx 透传 body.error / throwOnError 兼容位
// 降级/fallback 触发集合见设计 §4.4 D4-D8（本文件内穷举实现，无"视情况"分支）

import { AdapterHttpError } from './errors.js'

const DEFAULT_TIMEOUT = 8000
const FALLBACK_BASE = 'http://127.0.0.1:3080'

export class AdapterHttpImpl {
  constructor(deps) {
    this._cfg = deps.config || {}
    this._timeoutMs = (this._cfg.timeoutMs !== undefined ? this._cfg.timeoutMs : DEFAULT_TIMEOUT)
    this._fetch = (typeof globalThis !== 'undefined' && typeof globalThis.fetch === 'function') ? globalThis.fetch.bind(globalThis) : null
    this.degraded = []
    if (!this._fetch) this.degraded.push('adapterHttp.fetch missing (all calls ENETWORK)')
    if (!process.env.DSH_WEB_URL) this.degraded.push('adapterHttp.apiBase 无 DSH_WEB_URL（回退 127.0.0.1:3080）')
  }

  // B1
  apiBase() {
    const env = process.env.DSH_WEB_URL
    if (env && env.trim()) return String(env).replace(/\/+$/, '')
    return FALLBACK_BASE
  }

  _err(code, message, extra) {
    return new AdapterHttpError(code, message, extra)
  }

  async _request(method, path, opts) {
    const o = opts || {}
    const base = this.apiBase()
    let url = base + path
    let body = undefined
    let headers = {}
    const timeoutMs = (o.timeoutMs !== undefined ? o.timeoutMs : this._timeoutMs)
    if (o.body !== undefined) {
      body = typeof o.body === 'string' ? o.body : JSON.stringify(o.body)
      headers['Content-Type'] = 'application/json'
    } else if (method === 'POST') {
      // POST 默认避缓存：必达 host；空 body 也发（phase1/2 经验：POST 分支必达 host）
      headers['Content-Type'] = 'application/json'
    }
    if (method === 'GET' && (o.cacheBust === true || o.cacheBust === undefined)) {
      url += (url.includes('?') ? '&' : '?') + '__t=' + Date.now()
    }
    if (!this._fetch) {
      const err = this._err('ENETWORK', 'fetch unavailable (no-fetch)', { status: 0 })
      if (o.throwOnError === false) return { status: 0, ok: false, data: null, error: 'no-fetch' }
      throw err
    }
    const controller = (timeoutMs > 0) ? new AbortController() : null
    let timer = null
    if (controller) timer = setTimeout(function () { controller.abort() }, timeoutMs)
    let res
    try {
      res = await this._fetch(url, {
        method,
        headers,
        body: (body !== undefined) ? body : undefined,
        signal: controller ? controller.signal : undefined,
      })
    } catch (e) {
      if (timer) clearTimeout(timer)
      const aborted = e && (e.name === 'AbortError' || (controller && controller.signal.aborted))
      if (aborted) {
        const err = this._err('ETIMEOUT', 'request timeout after ' + timeoutMs + 'ms', { status: 0 })
        if (o.throwOnError === false) return { status: 0, ok: false, data: null, error: 'timeout' }
        throw err
      }
      const msg = (e && e.message) || String(e)
      const err = this._err('ENETWORK', 'network error: ' + msg, { status: 0 })
      if (o.throwOnError === false) return { status: 0, ok: false, data: null, error: 'network: ' + msg }
      throw err
    }
    if (timer) clearTimeout(timer)
    let data = null
    let parseFailed = false
    try {
      const text = await res.text()
      if (text) data = JSON.parse(text)
    } catch (e) {
      parseFailed = true
    }
    const status = res.status
    if (!res.ok || (data && data.ok === false) || parseFailed) {
      // 非 2xx 或 2xx 但信封 ok:false，或响应体非 JSON
      if (parseFailed && res.ok) {
        const err = this._err('EBADJSON', 'invalid json response', { status })
        if (o.throwOnError === false) return { status, ok: false, data: null, error: 'invalid json' }
        throw err
      }
      const remoteError = (data && (data.error || data.message)) ? (data.error || data.message) : ('HTTP ' + status)
      const err = this._err('HTTP_ERROR', remoteError, { status, remoteError, body: data })
      if (o.throwOnError === false) return { status, ok: false, data, error: remoteError }
      throw err
    }
    return { status, ok: true, data }
  }

  // B2：POST 默认
  post(path, payload, opts) {
    const o = opts || {}
    return this._request('POST', path, { body: payload, timeoutMs: o.timeoutMs, throwOnError: o.throwOnError })
  }

  // B3：GET + cache bust
  get(path, opts) {
    const o = opts || {}
    return this._request('GET', path, { timeoutMs: o.timeoutMs, throwOnError: o.throwOnError, cacheBust: o.cacheBust })
  }

  // 底层
  request(method, path, opts) {
    return this._request(method || 'GET', path, opts || {})
  }
}
